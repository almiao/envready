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

/**
 * Per-tool abort controller. Each tool install gets a fresh one so
 * Ctrl+C only kills the current tool, not all subsequent ones.
 * Double Ctrl+C exits the whole process.
 */
let abortController = new AbortController()
let ctrlCCount = 0

process.on("SIGINT", () => {
  ctrlCCount++
  if (ctrlCCount >= 2) {
    console.log(chalk.red("\n⚠ 强制退出"))
    process.exit(130)
  }
  console.log(chalk.yellow("\n⚠ 中断当前安装 (再按一次 Ctrl+C 退出全部)"))
  abortController.abort()
  // Give child processes 3s to clean up
  setTimeout(() => {
    if (ctrlCCount < 2) ctrlCCount = 0 // reset after cooldown
  }, 3000)
})

/** Reset abort controller for next tool */
function resetAbort() {
  abortController = new AbortController()
  ctrlCCount = 0
}

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
  /** Env setup commands specific to this method (overrides tool-level if present) */
  env_setup_commands?: string[]
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

          // Convert to ToolPlan — option-level env_setup overrides tool-level
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
            env_setup_commands: selected.env_setup_commands || tool.env_setup_commands,
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
      resetAbort() // Fresh abort controller per tool

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

        // Verify (for manual installs) — login shell so freshly installed tools are found
        if (tool.verify_command) {
          const verifySpinner = ora("验证安装...").start()
          try {
            const out = await Shell.exec(tool.verify_command, { login: true, timeout: 15_000 })
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

            // Env setup first, then verify in login shell
            if (tool.env_setup_commands.length > 0) {
              console.log(chalk.yellow("  配置环境变量..."))
              await Shell.session(tool.env_setup_commands, { prefix: "    " })
            }
            if (tool.verify_command) {
              try {
                const out = await Shell.exec(tool.verify_command, { login: true, timeout: 15_000 })
                console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
              } catch {
                console.log(chalk.yellow("  ⚠ 验证失败，可能需要重启 shell"))
              }
            }

            installed.add(tool.name)
          } else {
            console.log(chalk.red(`\n  ✖ ${tool.name}: ${result.message}`))
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(chalk.red(`\n  ✖ ${tool.name} 包安装失败`))
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

      // Execute all commands in a single shell session (env changes persist between commands)
      console.log(chalk.gray(`  正在安装 ${tool.name}... (Ctrl+C 中断)`))
      let success = true
      try {
        // Show elapsed timer until first output arrives
        let gotOutput = false
        const start = Date.now()
        const ticker = setInterval(() => {
          if (!gotOutput) {
            const s = Math.round((Date.now() - start) / 1000)
            process.stderr.write(`\r  ${chalk.dim(`⏳ 等待响应... (${s}s)`)}`)
          }
        }, 1000)

        await Shell.session(tool.commands, {
          prefix: "  ",
          timeout: 600_000,
          stallTimeout: STALL_TIMEOUT,
          onStall: createStallHandler(agent, tool.name),
          signal: abortController.signal,
          onLine: () => {
            if (!gotOutput) {
              gotOutput = true
              clearInterval(ticker)
              process.stderr.write("\r" + " ".repeat(40) + "\r") // clear timer line
            }
          },
        })
        clearInterval(ticker)
        console.log()
        console.log(chalk.green(`  ✔ ${tool.name} 安装完成`))

        // Execute env setup commands (before verify, so profile has the config)
        if (tool.env_setup_commands.length > 0) {
          console.log(chalk.yellow("  配置环境变量..."))
          await Shell.session(tool.env_setup_commands, { prefix: "    " })
          console.log(chalk.gray("  提示：重启 shell 使环境变量生效，或执行 source ~/.zshrc"))
        }

        // Verify in a login shell so freshly-written .zshrc/.bash_profile are loaded
        // This way sdkman/nvm/pyenv tools installed above are discoverable
        if (tool.verify_command) {
          try {
            const out = await Shell.exec(tool.verify_command, { login: true, timeout: 15_000 })
            console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
          } catch {
            console.log(chalk.yellow("  ⚠ 验证失败，可能需要重启 shell 或手动检查"))
            success = false
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isStall = err instanceof Shell.StallError
        Log.file(`[INSTALL:EXEC_ERROR] ${tool.name}: ${msg}`)
        console.log(chalk.red(`\n  ✖ ${tool.name} ${isStall ? "安装超时无响应" : "安装失败"}`))

        // ── Autonomous error recovery loop ──
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
          "env_setup_commands": ["echo 'export JAVA_HOME=\"$(brew --prefix openjdk@22)\"' >> ~/.zshrc", "echo 'export PATH=\"$JAVA_HOME/bin:$PATH\"' >> ~/.zshrc"],
          "pros": "开源免费，系统集成好",
          "cons": "仅包含 JRE，需手动配 JAVA_HOME"
        },
        {
          "label": "Oracle JDK",
          "method": "open_url",
          "commands": [],
          "env_setup_commands": [],
          "pros": "Oracle 官方支持，包含 JMC 等工具",
          "cons": "需要注册 Oracle 账号下载"
        }
      ],
      "verify_command": "java --version",
      "env_setup_commands": [],
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
- env_setup_commands（**每个方案独立的环境配置**，不同方案路径不同！）
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
  action: "commands" | "alternative" | "skip"
  /** Explanation of the diagnosis and what will be done */
  explanation: string
  /** Shell commands to fix the issue (for action=commands) */
  commands?: string[]
  /** Whether to retry original commands after fix (for action=commands) */
  retry?: boolean
  /** Alternative install plan (for action=alternative) */
  alternative?: {
    method: string
    commands: string[]
    download_url?: string
  }
}

const MAX_AUTO_ATTEMPTS = 3
/** Stall check interval: 10s without output → ask AI to decide wait/kill */
const STALL_TIMEOUT = 10_000

/**
 * Create an AI-driven stall handler.
 *
 * When a process produces no output for STALL_TIMEOUT ms, instead of blindly
 * killing it, we ask the AI: "The process has no output for 2 min. Here's the
 * command and last output. Should we keep waiting or kill it?"
 *
 * Examples of AI reasoning:
 * - `brew install gcc` last output "==> Compiling..." 3 min ago → wait (compiling is slow)
 * - `curl -o file.dmg https://...` progress stuck at 0% for 2 min → kill (network issue)
 * - `npm install` no output 5 min → kill (likely hung)
 */
function createStallHandler(agent: AI, toolName: string): (info: Shell.StallInfo) => Promise<"wait" | "kill"> {
  return async (info) => {
    Log.file(`[STALL] ${toolName}: stallCount=${info.stallCount} elapsed=${Math.round(info.elapsed / 1000)}s`)
    console.log(chalk.yellow(`\n  ⏳ ${toolName}: ${Math.round(info.elapsed / 1000)}s 无输出 (第 ${info.stallCount} 次检测)`))
    console.log(chalk.gray(`  AI 正在判断是否需要中断...`))

    try {
      const response = await agent.chat(`## 进程无响应判断

安装命令已经 ${Math.round(info.elapsed / 1000)} 秒没有任何输出。已检测 ${info.stallCount} 次（每 ${Math.round(STALL_TIMEOUT / 1000)}s 检测一次）。

命令: ${info.cmd.slice(0, 200)}
最后输出: ${info.lastOutput || "(无)"}

回复 WAIT 或 KILL：
- WAIT: 编译/构建、brew install 解压/编译、大文件下载波动、总时间 <5min 的等场景
- KILL: 进度完全卡住、简单命令超时、已等待超过 5 分钟且非编译场景、输出是错误信息后就没了

只回复一个词。`)

      const decision = response.trim().toUpperCase().includes("WAIT") ? "wait" : "kill" as const
      Log.file(`[STALL:DECISION] ${toolName}: ${decision}`)

      if (decision === "wait") {
        console.log(chalk.green(`  ✔ AI 判断: 继续等待（可能在编译/解压中）`))
      } else {
        console.log(chalk.red(`  ✖ AI 判断: 进程可能卡死，中断执行`))
      }

      return decision
    } catch {
      // AI failed, use simple heuristic: first stall → wait, subsequent → kill
      const decision = info.stallCount <= 1 ? "wait" : "kill" as const
      console.log(chalk.yellow(`  ⚠ AI 判断失败，${decision === "wait" ? "继续等待" : "中断执行"}`))
      return decision
    }
  }
}

/**
 * Clean up raw error messages for display.
 * Removes internal session script noise (set -e, echo lines).
 */
function cleanError(raw: string): string {
  return raw
    .replace(/set -e\n/g, "")
    .replace(/echo '.*?'\n/g, "")
    .replace(/Command failed \(exit \d+\): set -e\n[\s\S]*?\n(?=[A-Z=])/g, "")
    .trim()
    .slice(0, 300)
}

/**
 * Autonomous error recovery loop — AI decides what to do.
 *
 * Flow:
 * 1. Error occurs → AI analyzes error + context → decides: fix / alternative / skip
 * 2. If fix: execute fix commands → retry original install
 * 3. If alternative: execute alternative commands
 * 4. If skip or exhausted: give up
 *
 * User can always Ctrl+C to abort the entire process.
 * No r/a/m/s menu — AI makes the call.
 */
async function errorRecoveryLoop(
  agent: AI,
  tool: ToolPlan,
  error: string,
  ctx: Installer.Context,
): Promise<boolean> {
  Log.stage("Install:error-recovery", `tool=${tool.name}`)

  for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS; attempt++) {
    const displayError = cleanError(error)
    console.log()
    console.log(chalk.red(`  ✖ ${tool.name} 安装失败 (${attempt}/${MAX_AUTO_ATTEMPTS})`))
    console.log(chalk.gray(`  错误: ${displayError}`))
    console.log(chalk.gray(`  AI 正在自动分析并尝试修复... (Ctrl+C 跳过)`))

    // AI autonomously decides what to do
    let fix: FixAction
    try {
      fix = await askAIForFix(agent, tool, error, attempt)
      Log.parsed(`recovery:fix(attempt=${attempt})`, fix)
    } catch (aiErr) {
      Log.file(`[RECOVERY:AI_ERROR] ${aiErr instanceof Error ? aiErr.message : String(aiErr)}`)
      console.log(chalk.yellow(`  ⚠ AI 分析失败，跳过 ${tool.name}`))
      return false
    }

    // AI says skip — respect it
    if (fix.action === "skip") {
      console.log()
      console.log(chalk.yellow(`  ⏭ AI 判断无法自动修复: ${fix.explanation}`))
      return false
    }

    // AI proposes an alternative approach
    if (fix.action === "alternative" && fix.alternative) {
      console.log()
      console.log(chalk.yellow(`  🔄 [${attempt}/${MAX_AUTO_ATTEMPTS}] 切换安装方案: ${fix.explanation}`))

      try {
        // If alternative has a download_url, use Package.fromUrl for proper dmg/pkg handling
        if (fix.alternative.download_url && fix.alternative.method === "package_install") {
          console.log(chalk.dim(`     ⬇ ${fix.alternative.download_url}`))
          console.log()
          const result = await Package.fromUrl(fix.alternative.download_url, { name: tool.name })
          if (!result.ok) throw new Error(result.message)
        } else {
          for (const cmd of fix.alternative.commands) {
            console.log(chalk.dim(`     $ ${cmd}`))
          }
          console.log()
          await Shell.session(fix.alternative.commands, {
            prefix: "  ",
            timeout: 600_000,
            stallTimeout: STALL_TIMEOUT,
            onStall: createStallHandler(agent, tool.name),
            signal: abortController.signal,
          })
        }
        console.log(chalk.green(`\n  ✔ ${tool.name} 替代方案执行成功`))

        // Verify in login shell
        if (tool.verify_command) {
          try {
            const out = await Shell.exec(tool.verify_command, { login: true, timeout: 15_000 })
            console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
          } catch {
            console.log(chalk.yellow("  ⚠ 验证失败，可能需要重启 shell"))
          }
        }
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isStall = err instanceof Shell.StallError
        console.log(chalk.red(`\n  ✖ 替代方案${isStall ? "超时无响应" : "失败"}: ${cleanError(msg)}`))
        error = `替代方案 (${fix.alternative.method}) 失败: ${msg}`
        continue
      }
    }

    // AI proposes fix commands (and optionally retry)
    if (fix.action === "commands" && fix.commands && fix.commands.length > 0) {
      console.log()
      console.log(chalk.yellow(`  🔧 [${attempt}/${MAX_AUTO_ATTEMPTS}] ${fix.explanation}`))
      for (const cmd of fix.commands) {
        console.log(chalk.dim(`     $ ${cmd}`))
      }
      console.log()

      try {
        await Shell.session(fix.commands, {
          prefix: "  ",
          timeout: 600_000,
          stallTimeout: STALL_TIMEOUT,
          onStall: createStallHandler(agent, tool.name),
          signal: abortController.signal,
        })
        console.log(chalk.green(`  ✔ 修复命令执行成功`))
      } catch (fixErr) {
        const msg = fixErr instanceof Error ? fixErr.message : String(fixErr)
        console.log(chalk.red(`\n  ✖ 修复命令失败: ${cleanError(msg)}`))
        error = `修复命令失败: ${msg}`
        continue
      }

      // Retry original install if AI says so (default: true)
      if (fix.retry !== false) {
        console.log(chalk.gray(`\n  重新安装 ${tool.name}...\n`))
        try {
          await Shell.session(tool.commands, {
            prefix: "  ",
            timeout: 600_000,
            stallTimeout: STALL_TIMEOUT,
            onStall: createStallHandler(agent, tool.name),
            signal: abortController.signal,
          })
          console.log(chalk.green(`\n  ✔ ${tool.name} 安装成功`))

          if (tool.verify_command) {
            try {
              const out = await Shell.exec(tool.verify_command, { login: true, timeout: 15_000 })
              console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
            } catch {
              console.log(chalk.yellow("  ⚠ 验证失败，但安装命令已成功"))
            }
          }
          return true
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
          console.log(chalk.red(`\n  ✖ 重试失败: ${cleanError(msg)}`))
          error = `修复后重试失败: ${msg}`
          continue
        }
      }

      // fix.retry === false means fix commands alone should be enough (e.g. pip install xxx)
      if (tool.verify_command) {
        try {
          const out = await Shell.exec(tool.verify_command, { login: true, timeout: 15_000 })
          console.log(chalk.green(`  ✔ 已验证: ${out.trim().slice(0, 80)}`))
          return true
        } catch {
          error = "修复后验证仍失败"
          continue
        }
      }
      return true
    }
  }

  console.log(chalk.red(`  ✖ ${tool.name} 经过 ${MAX_AUTO_ATTEMPTS} 次自动修复尝试仍未成功`))
  Log.file(`[RECOVERY:EXHAUSTED] ${tool.name} after ${MAX_AUTO_ATTEMPTS} attempts`)
  return false
}

/**
 * Ask AI to analyze an error and autonomously decide the best recovery action.
 *
 * The AI sees the full context (error, OS, history) and decides:
 * - "commands": run fix commands, then retry original install
 * - "alternative": abandon original method, try a completely different approach
 * - "skip": this can't be auto-fixed (e.g. requires license acceptance, GUI, etc.)
 */
async function askAIForFix(agent: AI, tool: ToolPlan, error: string, attempt: number): Promise<FixAction> {
  const osInfo = OS.detect()

  const p = `## 安装错误自动诊断

### 软件
- 名称: ${tool.name}@${tool.version}
- 安装方式: ${tool.method}
- 原始命令: ${tool.commands.join(" && ")}

### 错误信息
${error}

### 修复历史
- 这是第 ${attempt} 次尝试（共 ${MAX_AUTO_ATTEMPTS} 次机会）
${attempt > 1 ? "- 之前的修复方案失败了，需要尝试不同的思路" : ""}

### 当前环境
- OS: ${osInfo.name} ${osInfo.version} (${osInfo.arch})
- Shell: ${osInfo.shell}
- 包管理器: ${OS.packageManagers().join(", ") || "无"}

### 你的任务
你是自动错误修复系统。**不需要用户确认**，你直接决定最佳修复方案。

分析错误根因，选择最优策略：

1. **action="commands"** — 你能确定错误原因，给出修复命令
   - 修复命令解决前置问题（如依赖缺失、权限、brew 更新等）
   - 修复后系统会自动重试原始安装命令
   - 如果修复命令本身就包含了安装（如换了一种安装方式），设置 retry=false

2. **action="alternative"** — 原方法不可行，换一种完全不同的方式
   - 例如 brew 装不了就改用 curl 脚本、直接下载安装包等
   - 提供 alternative.commands (完整安装命令)
   - 如果是 .dmg/.pkg 安装包，用 alternative.download_url 直链

3. **action="skip"** — 无法自动修复
   - 需要用户手动操作（如注册账号、接受许可证、GUI 操作等）
   - 在 explanation 里告诉用户该怎么做

### 决策指南
- 第 1 次优先尝试修复原方法（commands）
- 如果之前已尝试过修复（attempt > 1），优先换方案（alternative）
- 如果错误是 "stalled / no output"，说明进程卡死，应换一种方式
- 如果涉及网络问题，可尝试换源或设代理
- 如果涉及版本不存在，换可用版本或其他来源
- **重要：如果安装工具（如 sdkman/nvm）成功但随后的使用命令失败，修复时要在 commands 中包含 source/init 命令**

### 输出格式
返回**纯 JSON**（无 markdown 代码块）：

{
  "action": "commands" | "alternative" | "skip",
  "explanation": "中文，一句话说明诊断和方案",
  "commands": ["仅 action=commands 时，修复命令列表"],
  "retry": true,
  "alternative": {
    "method": "仅 action=alternative 时",
    "commands": ["替代安装命令"],
    "download_url": "可选，package_install 时填直链"
  }
}`

  Log.prompt("askAIForFix", p)
  const response = await agent.chat(p)

  const cleaned = response
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim()

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { action: "skip", explanation: "AI 未能返回有效的修复方案" }
  }

  try {
    return JSON.parse(jsonMatch[0]) as FixAction
  } catch {
    return { action: "skip", explanation: "AI 返回了无法解析的内容" }
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
