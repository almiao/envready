import type { CommandModule } from "yargs"
import chalk from "chalk"
import ora from "ora"
import { createInterface } from "readline"
import { Registry, ready } from "../../installer/registry"
import { Shell } from "../../executor/shell"
import { Package } from "../../executor/package"
import { OS } from "../../detect/os"
import { Software } from "../../detect/software"
import { Log } from "../../util/log"
import { AI } from "../../ai/agent"
import type { Installer } from "../../installer/installer"

/** Global abort controller — Ctrl+C triggers this to kill running child processes */
const abortController = new AbortController()

process.on("SIGINT", () => {
  console.log()
  console.log(chalk.yellow("\n⚠ 中断信号 (Ctrl+C) — 正在停止..."))
  abortController.abort()
  // Give child processes 3s to clean up, then force exit
  setTimeout(() => process.exit(130), 3000)
})

function createContext(): Installer.Context {
  const os = OS.detect()
  return {
    platform: os.platform,
    arch: os.arch,
    shell: os.shell,
    home: os.home,
    log: (msg) => Log.step(msg),
    exec: async (cmd) => {
      Log.exec(cmd)
      try {
        const out = await Shell.exec(cmd, { timeout: 600_000 })
        Log.exec(cmd, { ok: true, output: out.slice(0, 500) })
        return out
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        Log.exec(cmd, { ok: false, error: msg })
        throw err
      }
    },
  }
}

/**
 * Execute a command with real-time streaming output.
 * Shows live progress to the user (download bars, build output, etc.)
 * Returns captured stdout for further processing.
 */
async function streamExec(cmd: string, opts?: { prefix?: string; timeout?: number }): Promise<string> {
  Log.exec(cmd)
  try {
    const result = await Shell.stream(cmd, {
      prefix: opts?.prefix || "  ",
      timeout: opts?.timeout || 600_000,
      signal: abortController.signal,
    })
    Log.exec(cmd, { ok: true, output: result.stdout.slice(0, 500) })
    return result.stdout
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    Log.exec(cmd, { ok: false, error: msg })
    throw err
  }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ══════════════════════════════════════════════════════
//  Types: AI returns a full, actionable install plan
// ══════════════════════════════════════════════════════

/** A single tool in the AI-generated plan */
interface ToolPlan {
  /** Standard software name (lowercase, e.g. "fnm") */
  name: string
  /** Concrete version number (e.g. "1.38.1", "20.11.0"), NOT "latest" or "null" */
  version: string
  /** One-line description of what this tool is */
  description: string
  /** Why this tool is needed for the user's goal */
  reason: string
  /** How to install: "brew", "curl", "npm", "apt", "package_install", "open_url", etc. */
  method: string
  /** Source URL or package name (e.g. "https://fnm.vercel.app", "brew/fnm") */
  source: string
  /** Direct download URL for package_install method (.dmg, .pkg, .zip, .deb, .rpm, .AppImage, .exe, .msi, .tar.gz) */
  download_url?: string
  /** Ordered shell commands to execute for installation */
  commands: string[]
  /** Command to verify installation succeeded (e.g. "fnm --version") */
  verify_command: string
  /** Environment variable setup commands (NOT hardcoded paths, but commands to get paths) */
  env_setup_commands: string[]
  /** If true, user must do something manually (e.g. open a URL to login/download) */
  manual_action: boolean
  /** Description of manual action if manual_action=true */
  manual_instruction?: string
  /** Names of other tools in this plan that must be installed first */
  depends_on: string[]
}

/** Installation method option (for tools with multiple install methods) */
interface MethodOption {
  /** Method label (e.g. "Homebrew (推荐)", "官方安装包", "从源码编译") */
  label: string
  /** install method tag */
  method: string
  /** Direct download URL for package_install method */
  download_url?: string
  /** Commands for this method */
  commands: string[]
  /** Pros of this method */
  pros: string
  /** Cons of this method (optional) */
  cons?: string
}

/** A tool with multiple installation options */
interface ToolWithOptions {
  name: string
  version: string
  description: string
  reason: string
  /** Available installation methods */
  options: MethodOption[]
  verify_command: string
  env_setup_commands: string[]
  depends_on: string[]
}

/** Full AI response */
interface AnalyzeResult {
  action: "install" | "clarify"
  /** Only when action="install" */
  tools?: ToolPlan[]
  /** Tools with multiple installation options (user should choose) */
  tools_with_options?: ToolWithOptions[]
  /** Only when action="clarify" */
  question?: string
}

export const InstallCommand: CommandModule = {
  command: "install <input..>",
  describe: "Install software (name, natural language, or comma-separated list)",
  builder: (yargs) =>
    yargs
      .positional("input", {
        describe: 'Software name (e.g. "node") or intent (e.g. "前端开发环境")',
        type: "string",
        array: true,
        demandOption: true,
      })
      .option("ver", {
        alias: "V",
        type: "string",
        describe: "Version to install (for single software)",
      })
      .option("dry-run", {
        type: "boolean",
        describe: "Show what would be installed without actually installing",
        default: false,
      })
      .option("skipAi", {
        type: "boolean",
        describe: "Skip AI analysis, only use local installers",
        default: false,
      }),
  handler: async (argv) => {
    await ready

    const input = (argv.input as string[]).join(" ")
    const version = argv.ver as string | undefined
    const dryRun = argv["dry-run"] as boolean
    const noAI = argv.skipAi as boolean
    const ctx = createContext()

    Log.stage("Install:start", `input="${input}" version=${version || "auto"} dryRun=${dryRun} noAI=${noAI}`)

    // ──────────────────────────────────────────────────
    // Path A: skipAi — direct local installer lookup
    // ──────────────────────────────────────────────────

    if (noAI) {
      Log.stage("Install:parse", "skipAi mode — direct name parsing")
      const names = input.split(/[\s,]+/).filter(Boolean)
      Log.parsed("targets(skipAi)", names)

      for (const name of names) {
        await executeLocalInstall(name, version, ctx, dryRun)
      }

      Log.stage("Install:done")
      console.log()
      return
    }

    // ──────────────────────────────────────────────────
    // Path B: AI-driven — one call, full actionable plan
    // ──────────────────────────────────────────────────

    Log.stage("Install:ai-analyze", "AI mode — full plan generation")
    const modelConfig = AI.resolve()
    if (!modelConfig) return

    const systemContext = gatherContext()
    Log.fileData("systemContext", systemContext)
    const agent = new AI(modelConfig, systemContext)

    console.log()
    const spinner = ora("AI 正在分析需求并生成安装方案...").start()

    let plan: ToolPlan[] = []
    let userInput = input

    // Allow up to 3 rounds of clarification
    for (let round = 0; round < 3; round++) {
      Log.stage("Install:analyze-round", `round=${round + 1} input="${userInput}"`)
      const result = await analyzeIntent(agent, userInput, version)
      Log.parsed(`analyzeResult(round=${round + 1})`, result)

      if (result.action === "clarify") {
        spinner.stop()
        Log.file(`[CLARIFY] round=${round + 1} question="${result.question}"`)
        console.log()
        console.log(chalk.yellow("🤔 AI 需要更多信息："))
        console.log(chalk.white(`   ${result.question}`))
        console.log()

        const answer = await prompt(chalk.cyan("你的回答 > "))
        Log.file(`[CLARIFY:ANSWER] "${answer}"`)
        if (!answer || answer === "exit" || answer === "quit") {
          Log.info("已取消")
          return
        }

        userInput = `${input}。补充说明：${answer}`
        spinner.start("AI 正在重新分析...")
        continue
      }

      if ((!result.tools || result.tools.length === 0) && (!result.tools_with_options || result.tools_with_options.length === 0)) {
        spinner.fail("AI 未能识别需要安装的软件")
        Log.file("[ANALYZE:EMPTY] No tools or tools_with_options returned")
        Log.info("请尝试更具体的描述，或直接指定软件名：envready install node python")
        return
      }

      spinner.succeed("安装方案已生成")
      plan = result.tools || []

      // Handle tools_with_options (let user choose method)
      if (result.tools_with_options && result.tools_with_options.length > 0) {
        console.log()
        console.log(chalk.bold("🔀 以下软件有多种安装方式，请选择："))
        console.log()

        for (const tool of result.tools_with_options) {
          console.log(chalk.bold(`  ${tool.name}@${tool.version}`) + chalk.gray(` — ${tool.description}`))
          console.log()

          for (let i = 0; i < tool.options.length; i++) {
            const opt = tool.options[i]!
            console.log(`    ${chalk.cyan(`${i + 1}.`)} ${opt.label}`)
            console.log(`       ${chalk.green("优势:")} ${opt.pros}`)
            if (opt.cons) console.log(`       ${chalk.yellow("劣势:")} ${opt.cons}`)
          }
          console.log()

          const choice = await prompt(
            chalk.cyan(`  选择 ${tool.name} 的安装方式 (1-${tool.options.length}, 或 s 跳过) > `),
          )
          Log.file(`[CHOICE] ${tool.name} choice="${choice}"`)

          if (choice.toLowerCase() === "s") {
            Log.info(`已跳过 ${tool.name}`)
            continue
          }

          const idx = parseInt(choice) - 1
          const selected = tool.options[idx]
          if (!selected) {
            Log.warn(`无效选择，跳过 ${tool.name}`)
            continue
          }

          // Convert to ToolPlan
          const isPackageInstall = selected.method === "package_install" && selected.download_url
          const manual = selected.method === "open_url" && !isPackageInstall
          plan.push({
            name: tool.name,
            version: tool.version,
            description: tool.description,
            reason: tool.reason,
            method: selected.method,
            source: selected.label,
            download_url: selected.download_url,
            commands: selected.commands,
            verify_command: tool.verify_command,
            env_setup_commands: tool.env_setup_commands,
            manual_action: manual,
            manual_instruction: manual ? `请打开浏览器手动下载并安装 ${tool.name}` : undefined,
            depends_on: tool.depends_on,
          })
        }
      }

      break
    }

    if (plan.length === 0) {
      Log.error("多次追问后仍未确定安装目标，请直接指定软件名")
      return
    }

    // ──────────────────────────────────────────────────
    // Display full plan
    // ──────────────────────────────────────────────────

    Log.stage("Install:confirm")

    console.log()
    console.log(chalk.bold("📋 安装方案："))
    console.log()

    for (let i = 0; i < plan.length; i++) {
      const t = plan[i]!
      const hasLocal = Registry.get(t.name)
      const badge = hasLocal ? chalk.green("[本地]") : chalk.blue(`[${t.method}]`)
      const deps = t.depends_on.length > 0 ? chalk.gray(` (依赖: ${t.depends_on.join(", ")})`) : ""
      const manual = t.manual_action ? chalk.yellow(" ⚠ 需手动操作") : ""

      console.log(`  ${chalk.gray(`${i + 1}.`)} ${chalk.bold(t.name)}@${chalk.cyan(t.version)} ${badge}${deps}${manual}`)
      console.log(`     ${chalk.gray(t.description)}`)
      console.log(`     ${chalk.gray(`安装方式: ${t.method} — ${t.source}`)}`)
      if (t.method === "package_install" && t.download_url) {
        const format = Package.detect(t.download_url.split("/").pop() || "")
        console.log(`     ${chalk.dim("⬇")} ${chalk.white(t.download_url)}`)
        console.log(`     ${chalk.gray(`格式: ${format} → 自动下载安装`)}`)
      }
      for (const cmd of t.commands) {
        console.log(`     ${chalk.dim("$")} ${chalk.white(cmd)}`)
      }
      if (t.manual_action && t.manual_instruction) {
        console.log(`     ${chalk.yellow("⚠")} ${chalk.yellow(t.manual_instruction)}`)
      }
      if (t.env_setup_commands.length > 0) {
        console.log(`     ${chalk.gray("环境配置:")}`)
        for (const cmd of t.env_setup_commands) {
          console.log(`     ${chalk.dim("$")} ${chalk.white(cmd)}`)
        }
      }
      console.log()

      Log.file(`[PLAN] ${i + 1}. ${t.name}@${t.version} method=${t.method} download=${t.download_url || "N/A"} commands=${t.commands.length} env_setup=${t.env_setup_commands.length} manual=${t.manual_action} deps=[${t.depends_on.join(",")}]`)
    }

    if (!dryRun) {
      const answer = await prompt(chalk.cyan("确认安装以上软件？(Y/n/e 编辑) > "))
      Log.file(`[CONFIRM] answer="${answer}"`)

      if (answer.toLowerCase() === "n" || answer === "exit") {
        Log.info("已取消安装")
        return
      }

      if (answer.toLowerCase() === "e") {
        console.log(chalk.gray("请输入要安装的软件名（空格分隔），留空保持原方案："))
        const edited = await prompt(chalk.cyan("> "))
        if (edited) {
          const keep = new Set(edited.split(/[\s,]+/).filter(Boolean).map((n) => n.toLowerCase()))
          plan = plan.filter((t) => keep.has(t.name.toLowerCase()))
          Log.parsed("plan(edited)", plan.map((t) => t.name))
        }
      }
    }

    // ──────────────────────────────────────────────────
    // Execute plan (respecting dependency order)
    // ──────────────────────────────────────────────────

    Log.stage("Install:execute", `${plan.length} targets`)
    const installed = new Set<string>()

    for (const tool of plan) {
      // Check dependencies
      for (const dep of tool.depends_on) {
        if (!installed.has(dep)) {
          Log.warn(`依赖 ${dep} 未安装，${tool.name} 可能受影响`)
        }
      }

      // Prefer local installer if available
      const localInstaller = Registry.get(tool.name)

      if (localInstaller) {
        Log.file(`[INSTALL:LOCAL] ${tool.name} — using local installer`)
        console.log()
        console.log(chalk.bold(`📦 ${tool.name}@${tool.version}`) + chalk.green(" [本地安装器]") + chalk.gray(` — ${tool.description}`))

        const success = await executeLocalInstall(tool.name, tool.version, ctx, dryRun)
        if (success) installed.add(tool.name)
        continue
      }

      // AI plan execution
      Log.file(`[INSTALL:AI] ${tool.name} — using AI-generated plan`)
      console.log()
      console.log(chalk.bold(`📦 ${tool.name}@${tool.version}`) + chalk.blue(` [${tool.method}]`) + chalk.gray(` — ${tool.description}`))

      if (tool.manual_action) {
        console.log()
        console.log(chalk.yellow(`  ⚠ 需要手动操作`))
        if (tool.manual_instruction) {
          console.log(chalk.gray(`  ${tool.manual_instruction}`))
        }

        // Execute commands first (e.g., open URL)
        if (tool.commands.length > 0) {
          console.log()
          if (dryRun) {
            console.log(chalk.gray(`  准备执行的命令：`))
            for (const cmd of tool.commands) {
              console.log(chalk.dim(`    $ ${cmd}`))
            }
          } else {
            for (const cmd of tool.commands) {
              console.log(chalk.gray(`  $ ${cmd}`))
              try {
                await ctx.exec(cmd)
              } catch (err) {
                Log.warn(`命令执行失败: ${cmd}`)
              }
            }
          }
        }

        if (dryRun) {
          Log.info("[dry-run] 跳过")
          continue
        }

        // Wait for user
        const answer = await prompt(chalk.cyan("  完成安装后按回车继续，输入 s 跳过 > "))
        if (answer.toLowerCase() === "s") {
          Log.info(`已跳过 ${tool.name}`)
          continue
        }

        // Verify (for manual installs)
        if (tool.verify_command) {
          const verifySpinner = ora("验证安装...").start()
          try {
            const out = await ctx.exec(tool.verify_command)
            verifySpinner.succeed(`已安装: ${out.trim().slice(0, 80)}`)
            installed.add(tool.name)
          } catch {
            verifySpinner.warn("验证失败，可能未正确安装")
          }
        } else {
          installed.add(tool.name) // Trust user
        }

        continue
      }

      // ── package_install: download + auto-install package ──
      if (tool.method === "package_install" && tool.download_url) {
        if (dryRun) {
          const format = Package.detect(tool.download_url.split("/").pop() || "")
          console.log(chalk.gray(`  包安装模式：`))
          console.log(chalk.dim(`    下载: ${tool.download_url}`))
          console.log(chalk.dim(`    格式: ${format}`))
          console.log(chalk.dim(`    操作: 下载 → 识别格式 → 自动安装 → 清理`))
          if (tool.env_setup_commands.length > 0) {
            console.log(chalk.gray(`  环境配置命令：`))
            for (const cmd of tool.env_setup_commands) {
              console.log(chalk.dim(`    $ ${cmd}`))
            }
          }
          Log.info(`[dry-run] 跳过 ${tool.name}`)
          continue
        }

        console.log(chalk.gray(`  正在下载并安装 ${tool.name}... (Ctrl+C 中断)`))
        console.log()
        try {
          const result = await Package.fromUrl(tool.download_url, { name: tool.name })

          if (result.ok) {
            console.log()
            console.log(chalk.green(`  ✔ ${tool.name}: ${result.message}`))

            // Verify
            if (tool.verify_command) {
              try {
                const out = await ctx.exec(tool.verify_command)
                console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
              } catch {
                console.log(chalk.yellow("  ⚠ 验证失败，可能需要重启 shell"))
              }
            }

            // Env setup
            if (tool.env_setup_commands.length > 0) {
              console.log(chalk.yellow("  配置环境变量..."))
              for (const cmd of tool.env_setup_commands) {
                console.log(chalk.gray(`    $ ${cmd}`))
                try { await ctx.exec(cmd) } catch { Log.warn(`环境配置命令失败: ${cmd}`) }
              }
              console.log(chalk.gray("  提示：重启 shell 使环境变量生效，或执行 source ~/.zshrc"))
            }

            installed.add(tool.name)
          } else {
            console.log(chalk.red(`\n  ✖ ${tool.name}: ${result.message}`))
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(chalk.red(`\n  ✖ ${tool.name} 包安装失败: ${msg}`))
          Log.file(`[INSTALL:PKG_ERROR] ${tool.name}: ${msg}`)

          const recovered = await errorRecoveryLoop(agent, tool, msg, ctx)
          if (recovered) installed.add(tool.name)
        }

        continue
      }

      // ── Standard: execute shell commands directly ──
      if (dryRun) {
        console.log(chalk.gray(`  安装命令：`))
        for (const cmd of tool.commands) {
          console.log(chalk.dim(`    $ ${cmd}`))
        }
        if (tool.env_setup_commands.length > 0) {
          console.log(chalk.gray(`  环境配置命令：`))
          for (const cmd of tool.env_setup_commands) {
            console.log(chalk.dim(`    $ ${cmd}`))
          }
        }
        Log.info(`[dry-run] 跳过 ${tool.name}`)
        continue
      }

      // Execute commands (with live streaming output)
      console.log(chalk.gray(`  正在安装 ${tool.name}... (Ctrl+C 中断)`))
      console.log()
      let success = true
      try {
        for (const cmd of tool.commands) {
          console.log(chalk.dim(`  $ ${cmd}`))
          await streamExec(cmd, { prefix: "  " })
        }
        console.log()
        console.log(chalk.green(`  ✔ ${tool.name} 安装完成`))

        // Verify
        if (tool.verify_command) {
          try {
            const out = await ctx.exec(tool.verify_command)
            console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
          } catch {
            console.log(chalk.yellow("  ⚠ 验证失败，可能需要重启 shell 或手动检查"))
            success = false
          }
        }

        // Execute env setup commands
        if (tool.env_setup_commands.length > 0) {
          console.log(chalk.yellow("  配置环境变量..."))
          for (const cmd of tool.env_setup_commands) {
            console.log(chalk.gray(`    $ ${cmd}`))
            try {
              await ctx.exec(cmd)
            } catch (err) {
              Log.warn(`环境配置命令失败: ${cmd}`)
            }
          }
          console.log(chalk.gray("  提示：重启 shell 使环境变量生效，或执行 source ~/.zshrc"))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        Log.file(`[INSTALL:EXEC_ERROR] ${tool.name}: ${msg}`)
        console.log(chalk.red(`\n  ✖ ${tool.name} 安装失败: ${msg}`))

        // ── Error recovery loop ──
        const recovered = await errorRecoveryLoop(agent, tool, msg, ctx)
        if (recovered) {
          installed.add(tool.name)
        }
        continue
      }

      if (success) installed.add(tool.name)
    }

    // Summary
    Log.stage("Install:done")
    console.log()
    console.log(chalk.bold("Summary:"))
    console.log(`  ${chalk.green("✔")} ${installed.size}/${plan.length} succeeded`)
    if (installed.size < plan.length) {
      const failed = plan.filter((t) => !installed.has(t.name)).map((t) => t.name)
      console.log(`  ${chalk.red("✖")} failed: ${failed.join(", ")}`)
    }
    console.log()
  },
}

// ══════════════════════════════════════════════════════
//  Local installer execution (skipAi path)
// ══════════════════════════════════════════════════════

async function executeLocalInstall(
  name: string,
  version: string | undefined,
  ctx: Installer.Context,
  dryRun: boolean,
): Promise<boolean> {
  const installer = Registry.get(name)
  if (!installer) {
    Log.error(`Unknown software: ${name}`)
    Log.info(`Available local installers: ${Registry.names().join(", ")}`)
    return false
  }

  console.log()
  console.log(chalk.bold(`📦 ${installer.name}`) + chalk.gray(` — ${installer.description}`))

  Log.stage(`Install:detect(${name})`)
  const spinner = ora("Checking...").start()
  const current = await installer.detect(ctx)
  Log.parsed(`detect(${name})`, current)

  if (current.installed) {
    spinner.info(`Already installed: ${chalk.green(current.version)} at ${chalk.gray(current.path || "?")}`)
    if (!version) {
      Log.info("Skipping (already installed). Use --ver to install a specific version.")
      return true
    }
  } else {
    spinner.info("Not currently installed")
  }

  if (dryRun) {
    Log.info(`[dry-run] Would install ${name}${version ? `@${version}` : ""}`)
    return true
  }

  const params = installer.parameters.parse({ ...(version ? { version } : {}) })
  Log.parsed(`params(${name})`, params)

  Log.stage(`Install:exec(${name})`)
  const installSpinner = ora(`Installing ${name}...`).start()
  try {
    const result = await installer.install(params, ctx)
    Log.parsed(`installResult(${name})`, result)

    if (result.success) {
      installSpinner.succeed(chalk.green(result.message || `${name} installed successfully`))
      const verified = await installer.verify(ctx)
      Log.parsed(`verify(${name})`, verified)
      if (verified.installed) Log.success(`Verified: ${verified.version}`)
      if (result.postInstall?.length) {
        for (const step of result.postInstall) console.log(chalk.gray(`    → ${step}`))
      }
      return true
    }
    installSpinner.fail(chalk.red(result.message || `Failed to install ${name}`))
    return false
  } catch (err) {
    installSpinner.fail(chalk.red(`Installation failed: ${err instanceof Error ? err.message : String(err)}`))
    return false
  }
}

// ══════════════════════════════════════════════════════
//  AI Intent Analysis — ONE call, FULL actionable plan
// ══════════════════════════════════════════════════════

async function analyzeIntent(agent: AI, input: string, versionHint?: string): Promise<AnalyzeResult> {
  const osInfo = OS.detect()
  const installed = Software.detect()
  const installedStr = installed.map((s) => `${s.name}@${s.version}`).join(", ") || "无"
  const managers = OS.packageManagers()

  const p = `## 任务

分析用户的软件安装需求，生成**完整的、可直接执行**的安装方案。

## 用户输入

"${input}"${versionHint ? `\n用户指定版本: ${versionHint}` : ""}

## 当前环境

- OS: ${osInfo.name} ${osInfo.version} (${osInfo.arch})
- Shell: ${osInfo.shell}
- 可用包管理器: ${managers.join(", ") || "无"}
- 已安装软件: ${installedStr}

## 输出格式

返回**纯 JSON**（不要 markdown 代码块、不要任何其他文字）。

### 场景 A：意图明确

{
  "action": "install",
  "tools": [
    {
      "name": "软件标准名(小写)",
      "version": "具体版本号(如 1.40.0, 22.11.0)，查询最新稳定版填入",
      "description": "软件是什么，一句话",
      "reason": "为什么用户需要它",
      "method": "安装方式(brew/apt/npm/curl/package_install/open_url)",
      "source": "具体来源(如 https://example.com/install.sh, brew/package-name)",
      "download_url": "仅 package_install 方式需要，直接下载链接(如 https://xxx.com/app-1.0.0-arm64.dmg)",
      "commands": ["完整 shell 命令1", "命令2"],
      "verify_command": "验证命令(如 java --version)",
      "env_setup_commands": ["获取并配置环境变量的命令，如 echo export JAVA_HOME=$(brew --prefix openjdk@22) >> ~/.zshrc"],
      "manual_action": false,
      "manual_instruction": "",
      "depends_on": ["依赖的其他工具名"]
    }
  ],
  "tools_with_options": [
    {
      "name": "java",
      "version": "22.0.2",
      "description": "Java 开发工具包",
      "reason": "用户要用 Java 开发",
      "options": [
        {
          "label": "OpenJDK (推荐)",
          "method": "brew",
          "commands": ["brew install openjdk@22"],
          "pros": "开源免费，系统集成好",
          "cons": "仅包含 JRE，需手动配 JAVA_HOME"
        },
        {
          "label": "Oracle JDK",
          "method": "open_url",
          "commands": [],
          "pros": "Oracle 官方支持，包含 JMC 等工具",
          "cons": "需要注册 Oracle 账号下载"
        }
      ],
      "verify_command": "java --version",
      "env_setup_commands": ["echo 'export JAVA_HOME=\"$(brew --prefix openjdk@22)\"' >> ~/.zshrc", "echo 'export PATH=\"$JAVA_HOME/bin:$PATH\"' >> ~/.zshrc"],
      "depends_on": []
    }
  ]
}

### 场景 B：意图不明

{"action": "clarify", "question": "追问问题"}

## 关键规则

### 1. 版本号必须具体
- 填写当前最新稳定版号（如 fnm → "1.40.0"，node → "22.11.0"，不要写 "latest"）

### 2. commands 必须可直接执行
- 适配当前 OS (${osInfo.platform}) 和架构 (${osInfo.arch})
- 完整命令，包括参数（如 \`npm install -g xxx@具体版本\`）
- 如果需要 sudo，命令里必须包含 sudo

### 3. env_setup_commands 是命令，不是静态路径
**错误示例**（硬编码路径）：
  "env_vars": {"JAVA_HOME": "/opt/homebrew/opt/openjdk@22"}

**正确示例**（动态获取路径的命令）：
  "env_setup_commands": [
    "echo 'export JAVA_HOME=\"$(brew --prefix openjdk@22)\"' >> ~/.zshrc",
    "echo 'export PATH=\"$JAVA_HOME/bin:$PATH\"' >> ~/.zshrc"
  ]

原理：\`$(brew --prefix openjdk@22)\` 会在执行时动态获取实际安装路径，适配 Intel/ARM Mac。

### 4. method 要准确分类
- **brew/apt/dnf** — 系统包管理器
- **npm/pip/cargo** — 语言包管理器
- **curl** — 脚本安装（如 rustup, nvm），commands 填 curl | bash 命令
- **package_install** — ⭐ 下载安装包并自动安装（.dmg/.pkg/.zip/.deb/.rpm/.AppImage/.exe/.msi/.tar.gz）
  - **必须**填写 \`download_url\`：直接下载链接（不是网页链接，是文件直链！）
  - commands 留空 \`[]\`（系统会自动处理：下载 → 识别格式 → 挂载/解压 → 安装 → 清理）
  - 适用于：VS Code, Docker Desktop, Postman, Sublime Text, Azul Zulu JDK 等有直链的 GUI 软件
  - download_url 必须指向实际文件，适配当前 OS (${osInfo.platform}) 和架构 (${osInfo.arch})
  - 例如 macOS ARM: \`"download_url": "https://update.code.visualstudio.com/latest/darwin-arm64/stable"\`
  - 支持的格式: .dmg, .pkg, .zip, .tar.gz, .deb, .rpm, .AppImage, .exe, .msi
- **open_url** — 必须用户亲自在浏览器操作的（如需登录账号、填表单、接受协议）
  - commands 填写 \`open <具体URL>\`（macOS 会自动打开浏览器）
  - manual_action 设为 true
  - 仅当软件没有直链下载、必须用户登录时才用此方式

### 优先级选择 method 的逻辑
1. **brew/apt** 等包管理器有的 → 优先用包管理器
2. 有**直接下载链接**的安装包 → 用 \`package_install\`
3. 有 curl 安装脚本的 → 用 \`curl\`
4. 只能在浏览器操作的 → 用 \`open_url\`

### 5. manual_action 的使用
当满足以下任一条件时，设 manual_action=true：
- 需要用户打开网页下载（method=open_url）
- 需要用户登录账号（如 Oracle JDK）
- 安装包需要交互式配置（如 MySQL 设置 root 密码）

manual_instruction 要写清楚每一步操作（编号列表），例如：
- "1. 浏览器会打开 Oracle 官网，请使用 Oracle 账号登录\n2. 点击 macOS ARM64 的 .dmg 下载\n3. 双击下载的 .dmg 文件，按提示安装"

**重要**：即使是 manual_action=true，commands 也不能为空！
- method=open_url → commands 填 \`["open <URL>"]\`
- method=manual_download → commands 填下载命令 + open 命令

### 6. 多方案输出（tools_with_options）
某些软件有多种安装方式，各有优劣，应该让用户选择：
- **Java**: OpenJDK (brew) vs Oracle JDK (官网下载需登录) vs Azul Zulu
- **Python**: 系统 Python vs pyenv vs Anaconda
- **Node.js**: fnm vs nvm vs 官方安装包

对这类软件，使用 \`tools_with_options\` 数组，每个 option 包含：
- label: 方案名称（如"Homebrew (推荐)"）
- method + commands
- pros / cons

用户会看到方案列表并交互选择（程序自动提示）。

### 7. depends_on 要完整
- pnpm/typescript/eslint/prettier 依赖 node
- pip/virtualenv 依赖 python
- cargo 工具依赖 rust

### 8. source 要写完整 URL
- 不要写 "brew/fnm"，应该写 "https://formulae.brew.sh/formula/fnm" 或 "https://github.com/Schniz/fnm"
- npm 包写 "https://www.npmjs.com/package/pnpm"

### 9. 不要推荐已安装的软件
已安装: ${installedStr}
除非用户明确要求不同版本。

### 10. 安装顺序
tools 数组按依赖关系排序（被依赖的在前），确保依次安装不会因缺少依赖而失败。

## 示例

用户输入："前端开发环境"

预期输出（注意 env_setup_commands 是命令，不是静态路径）：
\`\`\`json
{
  "action": "install",
  "tools": [
    {
      "name": "fnm",
      "version": "1.40.0",
      "description": "Node.js 版本管理器",
      "reason": "管理多版本 Node.js",
      "method": "brew",
      "source": "https://github.com/Schniz/fnm",
      "commands": ["brew install fnm"],
      "verify_command": "fnm --version",
      "env_setup_commands": [
        "echo 'eval \\"$(fnm env --use-on-cd)\\"' >> ~/.zshrc"
      ],
      "manual_action": false,
      "depends_on": []
    },
    {
      "name": "node",
      "version": "22.11.0",
      "description": "JavaScript 运行时",
      "reason": "前端项目编译和运行",
      "method": "fnm",
      "source": "https://nodejs.org",
      "commands": ["fnm install 22.11.0", "fnm use 22.11.0", "fnm default 22.11.0"],
      "verify_command": "node --version",
      "env_setup_commands": [],
      "manual_action": false,
      "depends_on": ["fnm"]
    }
  ],
  "tools_with_options": []
}
\`\`\`

用户输入："jdk22"

预期输出（有多方案）：
\`\`\`json
{
  "action": "install",
  "tools": [],
  "tools_with_options": [
    {
      "name": "java",
      "version": "22.0.2",
      "description": "Java 开发工具包",
      "reason": "用户需要 JDK 22 开发 Java 程序",
      "options": [
        {
          "label": "OpenJDK via Homebrew (推荐)",
          "method": "brew",
          "commands": ["brew install openjdk@22"],
          "pros": "快速、开源、系统集成好",
          "cons": "需手动配置 JAVA_HOME 和 PATH"
        },
        {
          "label": "Oracle JDK (官方)",
          "method": "open_url",
          "commands": ["open https://www.oracle.com/java/technologies/downloads/#java22"],
          "pros": "Oracle 官方支持，包含完整工具链",
          "cons": "需注册 Oracle 账号，手动下载安装"
        },
        {
          "label": "Azul Zulu JDK",
          "method": "package_install",
          "download_url": "https://cdn.azul.com/zulu/bin/zulu22.30.13-ca-jdk22.0.1-macosx_aarch64.dmg",
          "commands": [],
          "pros": "免费、无需注册、性能优化、全自动安装",
          "cons": ""
        }
      ],
      "verify_command": "java --version",
      "env_setup_commands": [
        "echo 'export JAVA_HOME=\"$(brew --prefix openjdk@22)\"' >> ~/.zshrc",
        "echo 'export PATH=\"$JAVA_HOME/bin:$PATH\"' >> ~/.zshrc"
      ],
      "depends_on": []
    }
  ]
}
\`\`\``

  Log.prompt("analyzeIntent", p)

  const response = await agent.chat(p)

  const cleaned = response
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim()

  Log.file(`[ANALYZE:CLEANED] ${cleaned.slice(0, 1000)}`)

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    Log.file("[ANALYZE:NO_JSON] Could not extract JSON from response")
    return { action: "clarify", question: "我没有理解你的需求，可以更具体地描述吗？比如：你想安装什么软件，或者你想做什么类型的开发？" }
  }

  try {
    const result = JSON.parse(jsonMatch[0]) as AnalyzeResult
    Log.parsed("analyzeIntent:result", result)

    if (result.action === "install" && result.tools) {
      // Post-process: sanitize version fields
      for (const tool of result.tools) {
        if (!tool.version || tool.version === "null" || tool.version === "latest" || tool.version === "newest") {
          tool.version = "latest-stable"
        }
        if (!tool.commands) tool.commands = []
        if (!tool.env_setup_commands) tool.env_setup_commands = []
        if (!tool.depends_on) tool.depends_on = []
        if (!tool.verify_command) tool.verify_command = ""
      }
    }

    if (result.action === "install" && result.tools_with_options) {
      // Post-process: sanitize tools_with_options
      for (const tool of result.tools_with_options) {
        if (!tool.env_setup_commands) tool.env_setup_commands = []
        if (!tool.depends_on) tool.depends_on = []
        if (!tool.verify_command) tool.verify_command = ""
        for (const opt of tool.options) {
          if (!opt.commands) opt.commands = []
        }
      }
    }

    if (result.action === "install" && (!result.tools || result.tools.length === 0) && (!result.tools_with_options || result.tools_with_options.length === 0)) {
      Log.file("[ANALYZE:EMPTY_TOOLS] AI returned install but with empty tools and tools_with_options")
      return { action: "clarify", question: "我没有从你的描述中识别到具体的软件，可以告诉我你想安装什么吗？" }
    }

    return result
  } catch (err) {
    Log.file(`[ANALYZE:PARSE_ERROR] ${err instanceof Error ? err.message : String(err)}`)
    Log.fileData("analyzeIntent:rawJson", jsonMatch[0])
    return { action: "clarify", question: "解析出了问题，能否用更简单的方式描述你想安装什么？比如直接说 node、python 等软件名" }
  }
}

// ══════════════════════════════════════════════════════
//  Error Recovery Loop — AI-driven fix cycle
// ══════════════════════════════════════════════════════

interface FixAction {
  action: "commands" | "alternative" | "info"
  /** Shell commands to run (for action=commands) */
  commands?: string[]
  /** Explanation of what these commands do */
  explanation: string
  /** Alternative install plan (for action=alternative) */
  alternative?: {
    method: string
    commands: string[]
    download_url?: string
  }
  /** Additional info to show user (for action=info) */
  info?: string
}

const MAX_FIX_ATTEMPTS = 3

async function errorRecoveryLoop(
  agent: AI,
  tool: ToolPlan,
  error: string,
  ctx: Installer.Context,
): Promise<boolean> {
  Log.stage("Install:error-recovery", `tool=${tool.name}`)

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    console.log()
    console.log(chalk.red(`  ✖ ${tool.name} 安装失败 (尝试 ${attempt}/${MAX_FIX_ATTEMPTS})`))
    console.log(chalk.gray(`  错误: ${error.slice(0, 200)}`))
    console.log()
    console.log(chalk.bold("  选择操作："))
    console.log(`    ${chalk.cyan("r")} — 让 AI 分析错误并自动修复`)
    console.log(`    ${chalk.cyan("a")} — 让 AI 推荐替代安装方案`)
    console.log(`    ${chalk.cyan("m")} — 我手动修复，修完后继续验证`)
    console.log(`    ${chalk.cyan("s")} — 跳过此软件`)
    console.log()

    const choice = await prompt(chalk.cyan("  选择 (r/a/m/s) > "))
    Log.file(`[RECOVERY] tool=${tool.name} attempt=${attempt} choice="${choice}"`)

    if (choice.toLowerCase() === "s") {
      Log.info(`已跳过 ${tool.name}`)
      return false
    }

    if (choice.toLowerCase() === "m") {
      // User fixes manually, then we verify
      const done = await prompt(chalk.cyan("  手动修复完成后按回车继续 > "))
      if (tool.verify_command) {
        const spinner = ora("验证安装...").start()
        try {
          const out = await ctx.exec(tool.verify_command)
          spinner.succeed(`已安装: ${out.trim().slice(0, 80)}`)
          return true
        } catch {
          spinner.warn("验证失败")
          error = "手动修复后验证仍然失败"
          continue
        }
      }
      return true // No verify command, trust user
    }

    // AI-driven fix (r or a)
    const mode = choice.toLowerCase() === "a" ? "alternative" : "fix"
    const spinner = ora("AI 正在分析错误...").start()

    try {
      const fix = await askAIForFix(agent, tool, error, mode)
      spinner.stop()
      Log.parsed(`recovery:fix(attempt=${attempt})`, fix)

      if (fix.action === "info") {
        // AI provides diagnostic info only
        console.log()
        console.log(chalk.yellow("  💡 AI 诊断："))
        console.log(chalk.white(`     ${fix.explanation}`))
        if (fix.info) console.log(chalk.gray(`     ${fix.info}`))
        continue
      }

      if (fix.action === "alternative" && fix.alternative) {
        // AI suggests an entirely different approach
        console.log()
        console.log(chalk.yellow(`  🔄 AI 建议替代方案：`))
        console.log(chalk.white(`     ${fix.explanation}`))
        console.log(chalk.gray(`     方法: ${fix.alternative.method}`))
        for (const cmd of fix.alternative.commands) {
          console.log(chalk.dim(`     $ ${cmd}`))
        }
        console.log()

        const accept = await prompt(chalk.cyan("  执行替代方案？(Y/n) > "))
        if (accept.toLowerCase() === "n") continue

        // Execute alternative (with live output)
        console.log(chalk.gray(`\n  执行替代方案... (Ctrl+C 中断)\n`))
        try {
          for (const cmd of fix.alternative.commands) {
            console.log(chalk.dim(`  $ ${cmd}`))
            await streamExec(cmd, { prefix: "  " })
          }
          console.log(chalk.green(`\n  ✔ ${tool.name} 替代方案执行成功`))

          // Verify
          if (tool.verify_command) {
            try {
              const out = await ctx.exec(tool.verify_command)
              console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
              return true
            } catch {
              console.log(chalk.yellow("  ⚠ 验证失败"))
              error = "替代方案执行后验证仍然失败"
              continue
            }
          }
          return true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(chalk.red(`\n  ✖ 替代方案也失败: ${msg}`))
          error = `替代方案 (${fix.alternative.method}) 也失败: ${msg}`
          continue
        }
      }

      if (fix.action === "commands" && fix.commands && fix.commands.length > 0) {
        // AI provides fix commands
        console.log()
        console.log(chalk.yellow(`  🔧 AI 修复方案：`))
        console.log(chalk.white(`     ${fix.explanation}`))
        for (const cmd of fix.commands) {
          console.log(chalk.dim(`     $ ${cmd}`))
        }
        console.log()

        const accept = await prompt(chalk.cyan("  执行修复命令？(Y/n) > "))
        if (accept.toLowerCase() === "n") continue

        // Execute fix commands (with live output)
        console.log(chalk.gray(`\n  执行修复... (Ctrl+C 中断)\n`))
        try {
          for (const cmd of fix.commands) {
            console.log(chalk.dim(`  $ ${cmd}`))
            await streamExec(cmd, { prefix: "  " })
          }
          console.log(chalk.green(`  ✔ 修复命令执行成功`))

          // Now retry the original install
          console.log(chalk.gray(`\n  重新安装 ${tool.name}...\n`))
          try {
            for (const cmd of tool.commands) {
              console.log(chalk.dim(`  $ ${cmd}`))
              await streamExec(cmd, { prefix: "  " })
            }
            console.log(chalk.green(`\n  ✔ ${tool.name} 安装成功`))

            // Verify
            if (tool.verify_command) {
              try {
                const out = await ctx.exec(tool.verify_command)
                console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
                return true
              } catch {
                console.log(chalk.yellow("  ⚠ 验证失败，但安装命令已成功"))
                return true
              }
            }
            return true
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
            console.log(chalk.red(`\n  ✖ 重试仍然失败: ${msg}`))
            error = `修复后重试仍失败: ${msg}`
            continue
          }
        } catch (fixErr) {
          const msg = fixErr instanceof Error ? fixErr.message : String(fixErr)
          console.log(chalk.red(`\n  ✖ 修复命令执行失败: ${msg}`))
          error = `修复命令自身失败: ${msg}`
          continue
        }
      }
    } catch (aiErr) {
      spinner.fail("AI 分析失败")
      Log.file(`[RECOVERY:AI_ERROR] ${aiErr instanceof Error ? aiErr.message : String(aiErr)}`)
      continue
    }
  }

  console.log(chalk.red(`  ✖ ${tool.name} 经过 ${MAX_FIX_ATTEMPTS} 次尝试仍未成功`))
  Log.file(`[RECOVERY:EXHAUSTED] ${tool.name} after ${MAX_FIX_ATTEMPTS} attempts`)
  return false
}

async function askAIForFix(agent: AI, tool: ToolPlan, error: string, mode: "fix" | "alternative"): Promise<FixAction> {
  const osInfo = OS.detect()

  const modeInstruction = mode === "fix"
    ? `分析错误原因，给出**修复命令**（action="commands"）。修复命令应该解决根本问题（如安装依赖、修复权限、更新 brew 等），然后用户会重新执行原始安装命令。`
    : `提供一个**完全不同的安装方式**（action="alternative"），例如从命令行换成直接下载安装包，或换一个包管理器。`

  const p = `## 安装错误修复

### 软件
- 名称: ${tool.name}@${tool.version}
- 安装方式: ${tool.method}
- 原始命令: ${tool.commands.join(" && ")}

### 错误信息
${error}

### 当前环境
- OS: ${osInfo.name} ${osInfo.version} (${osInfo.arch})
- Shell: ${osInfo.shell}
- 包管理器: ${OS.packageManagers().join(", ") || "无"}

### 要求
${modeInstruction}

### 输出格式
返回**纯 JSON**（无 markdown 代码块）：

当 action="commands"（修复命令）:
{
  "action": "commands",
  "commands": ["修复命令1", "修复命令2"],
  "explanation": "一句话说明修复原因和操作"
}

当 action="alternative"（替代方案）:
{
  "action": "alternative",
  "explanation": "为什么推荐这个替代方案",
  "alternative": {
    "method": "新方法名(如 package_install, curl, manual_download)",
    "commands": ["替代安装命令1", "命令2"],
    "download_url": "如果是 package_install，填直链URL"
  }
}

当无法自动修复时:
{
  "action": "info",
  "explanation": "问题的根本原因",
  "info": "建议用户手动执行的步骤"
}

### 规则
1. commands 必须可直接执行，适配 ${osInfo.platform} / ${osInfo.arch}
2. 如果错误包含"Permission denied"，加 sudo
3. 如果是 brew 问题，可能需要先 \`brew update\` 或 \`brew doctor\`
4. 如果是网络问题，建议设置代理或换源
5. 修复命令只解决前置问题，不要重复原始安装命令
6. explanation 用中文`

  Log.prompt("askAIForFix", p)
  const response = await agent.chat(p)

  const cleaned = response
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim()

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { action: "info", explanation: "AI 未能返回有效的修复方案", info: response.slice(0, 300) }
  }

  try {
    return JSON.parse(jsonMatch[0]) as FixAction
  } catch {
    return { action: "info", explanation: "AI 返回了无法解析的内容", info: cleaned.slice(0, 300) }
  }
}

function gatherContext(): string {
  const os = OS.detect()
  const software = Software.detect()
  return `当前系统：
- OS: ${os.name} ${os.version} (${os.arch})
- Shell: ${os.shell}
- 包管理器: ${OS.packageManagers().join(", ") || "无"}
- 已安装软件: ${software.map((s) => `${s.name}@${s.version}`).join(", ") || "无"}
`
}
