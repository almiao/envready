import chalk from "chalk"
import { mkdirSync, appendFileSync } from "fs"
import { join } from "path"

export namespace Log {
  export type Level = "debug" | "info" | "warn" | "error"

  let currentLevel: Level = "info"
  let logFile: string | null = null

  const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

  export function setLevel(level: Level) {
    currentLevel = level
  }

  /** Initialize file logging. Call once at startup. */
  export function init() {
    const dir = logDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch {}
    const date = new Date().toISOString().slice(0, 10)
    logFile = join(dir, `envready-${date}.log`)
    file("────────────────────────────────────────")
    file(`Session started at ${new Date().toISOString()}`)
    file(`Args: ${process.argv.slice(2).join(" ")}`)
    file("────────────────────────────────────────")
  }

  export function logDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME
    const home = process.env.HOME || process.env.USERPROFILE || "~"
    const base = xdg ? join(xdg, "envready") : join(home, ".config", "envready")
    return join(base, "logs")
  }

  /** Get current log file path */
  export function logFilePath(): string | null {
    return logFile
  }

  function shouldLog(level: Level): boolean {
    return LEVELS[level]! >= LEVELS[currentLevel]!
  }

  /** Write a line to the log file (always, regardless of level) */
  export function file(msg: string) {
    if (!logFile) return
    const ts = new Date().toISOString().slice(11, 23)
    try {
      appendFileSync(logFile, `[${ts}] ${msg}\n`)
    } catch {}
  }

  /** Write a structured data block to the log file */
  export function fileData(label: string, data: unknown) {
    if (!logFile) return
    const ts = new Date().toISOString().slice(11, 23)
    const sep = "·".repeat(40)
    let content: string
    if (typeof data === "string") {
      content = data
    } else {
      try {
        content = JSON.stringify(data, null, 2)
      } catch {
        content = String(data)
      }
    }
    try {
      appendFileSync(logFile, `[${ts}] ┌─ ${label} ${sep}\n${content}\n[${ts}] └─ /${label}\n`)
    } catch {}
  }

  // ─── Terminal output (controlled by level) ───

  export function debug(msg: string, ...args: unknown[]) {
    file(`[DEBUG] ${msg} ${args.length ? JSON.stringify(args) : ""}`)
    if (shouldLog("debug")) console.error(chalk.gray(`[debug] ${msg}`), ...args)
  }

  export function info(msg: string, ...args: unknown[]) {
    file(`[INFO] ${msg}`)
    if (shouldLog("info")) console.log(chalk.blue("ℹ"), msg, ...args)
  }

  export function success(msg: string, ...args: unknown[]) {
    file(`[OK] ${msg}`)
    if (shouldLog("info")) console.log(chalk.green("✔"), msg, ...args)
  }

  export function warn(msg: string, ...args: unknown[]) {
    file(`[WARN] ${msg}`)
    if (shouldLog("warn")) console.log(chalk.yellow("⚠"), msg, ...args)
  }

  export function error(msg: string, ...args: unknown[]) {
    file(`[ERROR] ${msg}`)
    if (shouldLog("error")) console.error(chalk.red("✖"), msg, ...args)
  }

  export function step(msg: string) {
    file(`[STEP] ${msg}`)
    console.log(chalk.cyan("→"), msg)
  }

  export function blank() {
    console.log()
  }

  // ─── Specialized loggers for debugging ───

  /** Log AI prompt being sent */
  export function prompt(label: string, content: string) {
    file(`[AI:PROMPT] ${label}`)
    fileData(`PROMPT:${label}`, content)
    if (shouldLog("debug")) {
      console.error(chalk.gray(`[ai:prompt] ${label} (${content.length} chars)`))
    }
  }

  /** Log AI response received */
  export function response(label: string, content: string) {
    file(`[AI:RESPONSE] ${label} (${content.length} chars)`)
    fileData(`RESPONSE:${label}`, content)
    if (shouldLog("debug")) {
      console.error(chalk.gray(`[ai:response] ${label} (${content.length} chars)`))
      // In verbose mode, show first 200 chars of response on terminal
      const preview = content.slice(0, 200).replace(/\n/g, "\\n")
      console.error(chalk.gray(`  → ${preview}${content.length > 200 ? "..." : ""}`))
    }
  }

  /** Log parsed JSON data from AI */
  export function parsed(label: string, data: unknown) {
    file(`[PARSED] ${label}`)
    fileData(`PARSED:${label}`, data)
    if (shouldLog("debug")) {
      const str = JSON.stringify(data)
      const preview = str.slice(0, 200)
      console.error(chalk.gray(`[parsed] ${label}: ${preview}${str.length > 200 ? "..." : ""}`))
    }
  }

  /** Log shell command execution */
  export function exec(cmd: string, result?: { ok: boolean; output?: string; error?: string }) {
    file(`[EXEC] $ ${cmd}`)
    if (result) {
      if (result.ok) {
        file(`[EXEC:OK] ${result.output?.slice(0, 500) || "(no output)"}`)
      } else {
        file(`[EXEC:FAIL] ${result.error || "(no error message)"}`)
      }
    }
    if (shouldLog("debug")) {
      console.error(chalk.gray(`[exec] $ ${cmd.slice(0, 100)}${cmd.length > 100 ? "..." : ""}`))
    }
  }

  /** Log a stage/phase transition */
  export function stage(name: string, detail?: string) {
    const msg = detail ? `${name}: ${detail}` : name
    file(`[STAGE] ══ ${msg} ══`)
    if (shouldLog("debug")) {
      console.error(chalk.magenta(`[stage] ${msg}`))
    }
  }

  /** Log model config used */
  export function modelConfig(config: { provider: string; model: string; baseURL?: string }) {
    file(`[MODEL] provider=${config.provider} model=${config.model} baseURL=${config.baseURL || "(default)"}`)
    if (shouldLog("debug")) {
      console.error(chalk.gray(`[model] ${config.provider}/${config.model}${config.baseURL ? ` @ ${config.baseURL}` : ""}`))
    }
  }
}
