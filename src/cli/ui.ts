import chalk from "chalk"

export namespace UI {
  export function logo(): string {
    return chalk.bold.cyan(`
  ╔═══════════════════════════════════════╗
  ║           ⚡ envready                 ║
  ║   AI-powered environment setup tool   ║
  ╚═══════════════════════════════════════╝
    `)
  }

  export function header(text: string) {
    console.log()
    console.log(chalk.bold.underline(text))
    console.log()
  }

  export function table(rows: [string, string][]) {
    const maxKey = Math.max(...rows.map(([k]) => k.length))
    for (const [key, value] of rows) {
      console.log(`  ${chalk.gray(key.padEnd(maxKey))}  ${value}`)
    }
  }

  export function box(title: string, lines: string[]) {
    const maxLen = Math.max(title.length, ...lines.map((l) => l.length))
    const border = "─".repeat(maxLen + 2)
    console.log(chalk.gray(`┌${border}┐`))
    console.log(chalk.gray("│ ") + chalk.bold(title.padEnd(maxLen)) + chalk.gray(" │"))
    console.log(chalk.gray(`├${border}┤`))
    for (const line of lines) {
      console.log(chalk.gray("│ ") + line.padEnd(maxLen) + chalk.gray(" │"))
    }
    console.log(chalk.gray(`└${border}┘`))
  }

  export function divider() {
    console.log(chalk.gray("─".repeat(50)))
  }
}
