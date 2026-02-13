import type { CommandModule } from "yargs"
import chalk from "chalk"
import { Registry, ready } from "../../installer/registry"
import { Shell } from "../../executor/shell"
import { OS } from "../../detect/os"
import { UI } from "../ui"
import type { Installer } from "../../installer/installer"

export const ListCommand: CommandModule = {
  command: "list",
  describe: "List available software and their installation status",
  builder: (yargs) =>
    yargs
      .option("installed", {
        type: "boolean",
        describe: "Only show installed software",
      })
      .option("search", {
        alias: "s",
        type: "string",
        describe: "Search for software by name or tag",
      }),
  handler: async (argv) => {
    await ready

    let installers = Registry.all()

    const search = argv.search as string | undefined
    if (search) {
      installers = Registry.search(search)
      if (installers.length === 0) {
        console.log(chalk.yellow(`No software matching "${search}"`))
        return
      }
    }

    UI.header("Available Software")

    const os = OS.detect()
    const ctx: Installer.Context = {
      platform: os.platform,
      arch: os.arch,
      shell: os.shell,
      home: os.home,
      log: () => {},
      exec: (cmd) => Shell.exec(cmd),
    }

    const results = await Promise.all(
      installers.map(async (inst) => {
        const status = await inst.detect(ctx)
        return { installer: inst, status }
      }),
    )

    const onlyInstalled = argv.installed as boolean | undefined

    for (const { installer, status } of results) {
      if (onlyInstalled && !status.installed) continue

      const icon = status.installed ? chalk.green("✔") : chalk.gray("○")
      const ver = status.installed ? chalk.green(status.version) : chalk.gray("not installed")
      const tags = installer.tags.map((t) => chalk.gray(`#${t}`)).join(" ")

      console.log(`  ${icon} ${chalk.bold(installer.name.padEnd(12))} ${ver.padEnd(20)} ${chalk.gray(installer.description)}`)
      console.log(`    ${tags}`)
    }

    console.log()
    console.log(
      chalk.gray(`  Total: ${results.length} available, ${results.filter((r) => r.status.installed).length} installed`),
    )
    console.log()
  },
}
