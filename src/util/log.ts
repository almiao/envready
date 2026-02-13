import chalk from "chalk"

export namespace Log {
  export type Level = "debug" | "info" | "warn" | "error"

  let currentLevel: Level = "info"

  const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

  export function setLevel(level: Level) {
    currentLevel = level
  }

  function shouldLog(level: Level): boolean {
    return LEVELS[level] >= LEVELS[currentLevel]
  }

  export function debug(msg: string, ...args: unknown[]) {
    if (shouldLog("debug")) console.log(chalk.gray(`[debug] ${msg}`), ...args)
  }

  export function info(msg: string, ...args: unknown[]) {
    if (shouldLog("info")) console.log(chalk.blue("ℹ"), msg, ...args)
  }

  export function success(msg: string, ...args: unknown[]) {
    if (shouldLog("info")) console.log(chalk.green("✔"), msg, ...args)
  }

  export function warn(msg: string, ...args: unknown[]) {
    if (shouldLog("warn")) console.log(chalk.yellow("⚠"), msg, ...args)
  }

  export function error(msg: string, ...args: unknown[]) {
    if (shouldLog("error")) console.error(chalk.red("✖"), msg, ...args)
  }

  export function step(msg: string) {
    console.log(chalk.cyan("→"), msg)
  }

  export function blank() {
    console.log()
  }
}
