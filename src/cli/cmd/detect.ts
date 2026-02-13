import type { CommandModule } from "yargs"
import chalk from "chalk"
import { OS } from "../../detect/os"
import { Software } from "../../detect/software"
import { Env } from "../../detect/env"
import { UI } from "../ui"
import { Log } from "../../util/log"

export const DetectCommand: CommandModule = {
  command: "detect",
  describe: "Detect current system environment",
  builder: (yargs) =>
    yargs.option("json", {
      type: "boolean",
      describe: "Output as JSON",
      default: false,
    }),
  handler: async (argv) => {
    Log.stage("Detect:start")
    if (argv.json) {
      const result = {
        os: OS.detect(),
        packageManagers: OS.packageManagers(),
        software: Software.detect(),
        env: Env.summary(),
        path: Env.analyzePath(),
        shellProfile: Env.shellProfile(),
      }
      Log.parsed("detect:json", result)
      console.log(JSON.stringify(result, null, 2))
      return
    }

    // OS Info
    const os = OS.detect()
    Log.parsed("detect:os", os)
    UI.header("System Information")
    UI.table([
      ["OS", `${os.name} ${os.version}`],
      ["Arch", os.arch],
      ["Shell", os.shell],
      ["Home", os.home],
      ["User", os.user],
    ])

    // Package Managers
    const managers = OS.packageManagers()
    UI.header("Package Managers")
    if (managers.length === 0) {
      console.log(chalk.yellow("  No common package managers found"))
    } else {
      for (const m of managers) console.log(`  ${chalk.green("✔")} ${m}`)
    }

    // Installed Software
    UI.header("Installed Software")
    const software = Software.detect()
    Log.parsed("detect:software", software)
    if (software.length === 0) {
      console.log(chalk.yellow("  No common development tools found"))
    } else {
      UI.table(
        software.map((s) => [s.name, `${chalk.green(s.version)} ${chalk.gray(s.path)}`]),
      )
    }

    // Environment
    UI.header("Key Environment Variables")
    const env = Env.summary()
    const entries = Object.entries(env).filter(([k]) => k !== "PATH")
    if (entries.length === 0) {
      console.log(chalk.gray("  No notable environment variables set"))
    } else {
      UI.table(
        entries.map(([k, v]) => [k, v ?? ""]),
      )
    }

    // PATH analysis
    const pathInfo = Env.analyzePath()
    if (pathInfo.duplicates.length > 0) {
      UI.header("PATH Issues")
      console.log(chalk.yellow("  Duplicate entries:"))
      for (const d of pathInfo.duplicates) console.log(`    ${chalk.gray(d)}`)
    }

    console.log()
    console.log(chalk.gray(`  Shell profile: ${Env.shellProfile()}`))
    console.log()
  },
}
