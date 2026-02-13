import type { CommandModule } from "yargs"
import chalk from "chalk"
import ora from "ora"
import { Config } from "../../config/config"
import { Registry, ready } from "../../installer/registry"
import { Shell } from "../../executor/shell"
import { OS } from "../../detect/os"
import { Log } from "../../util/log"
import type { Installer } from "../../installer/installer"

export const ApplyCommand: CommandModule = {
  command: "apply [file]",
  describe: "Apply an envready configuration file",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "Path to envready config file (auto-detected if not specified)",
      type: "string",
    }),
  handler: async (argv) => {
    await ready

    const file = argv.file as string | undefined
    const config = file ? Config.parse(file) : Config.load()

    if (!config) {
      Log.error("No envready config file found")
      Log.info("Create an envready.yaml file or specify a path: envready apply ./envready.yaml")
      return
    }

    if (config.name) {
      console.log()
      console.log(chalk.bold(`📋 Applying environment: ${config.name}`))
      if (config.description) console.log(chalk.gray(`   ${config.description}`))
    }

    if (config.tools.length === 0) {
      Log.warn("No tools defined in config")
      return
    }

    // Pre-install hooks
    if (config.hooks?.pre_install) {
      Log.step("Running pre-install hooks...")
      for (const cmd of config.hooks.pre_install) {
        const spinner = ora(cmd).start()
        try {
          await Shell.exec(cmd)
          spinner.succeed()
        } catch (err) {
          spinner.fail(chalk.red(`Hook failed: ${cmd}`))
          return
        }
      }
    }

    const os = OS.detect()
    const ctx: Installer.Context = {
      platform: os.platform,
      arch: os.arch,
      shell: os.shell,
      home: os.home,
      log: (msg) => Log.step(msg),
      exec: (cmd) => Shell.exec(cmd),
    }

    // Install each tool
    let succeeded = 0
    let failed = 0

    for (const tool of config.tools) {
      const installer = Registry.get(tool.name)
      if (!installer) {
        Log.warn(`Unknown software: ${tool.name}, skipping`)
        failed++
        continue
      }

      const spinner = ora(`${tool.name}${tool.version ? `@${tool.version}` : ""}...`).start()

      // Check if already installed
      const current = await installer.detect(ctx)
      if (current.installed && !tool.version) {
        spinner.info(`${tool.name} already installed (${current.version})`)
        succeeded++
        continue
      }

      try {
        const params = installer.parameters.parse({
          ...(tool.version ? { version: tool.version } : {}),
          ...tool.config,
        })
        const result = await installer.install(params, ctx)

        if (result.success) {
          spinner.succeed(`${tool.name} ${chalk.green("installed")}`)
          succeeded++
        } else {
          spinner.fail(`${tool.name}: ${result.message}`)
          failed++
        }
      } catch (err) {
        spinner.fail(`${tool.name}: ${err instanceof Error ? err.message : String(err)}`)
        failed++
      }
    }

    // Post-install hooks
    if (config.hooks?.post_install) {
      Log.step("Running post-install hooks...")
      for (const cmd of config.hooks.post_install) {
        const spinner = ora(cmd).start()
        try {
          await Shell.exec(cmd)
          spinner.succeed()
        } catch {
          spinner.warn(`Hook failed: ${cmd}`)
        }
      }
    }

    console.log()
    console.log(chalk.bold("Summary:"))
    console.log(`  ${chalk.green("✔")} ${succeeded} succeeded`)
    if (failed > 0) console.log(`  ${chalk.red("✖")} ${failed} failed`)
    console.log()
  },
}
