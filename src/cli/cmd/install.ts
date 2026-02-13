import type { CommandModule } from "yargs"
import chalk from "chalk"
import ora from "ora"
import { Registry, ready } from "../../installer/registry"
import { Shell } from "../../executor/shell"
import { OS } from "../../detect/os"
import { Log } from "../../util/log"
import type { Installer } from "../../installer/installer"

function createContext(): Installer.Context {
  const os = OS.detect()
  return {
    platform: os.platform,
    arch: os.arch,
    shell: os.shell,
    home: os.home,
    log: (msg) => Log.step(msg),
    exec: (cmd) => Shell.exec(cmd),
  }
}

export const InstallCommand: CommandModule = {
  command: "install <software..>",
  describe: "Install one or more software tools",
  builder: (yargs) =>
    yargs
      .positional("software", {
        describe: "Software to install (e.g. node, python, go)",
        type: "string",
        array: true,
        demandOption: true,
      })
      .option("ver", {
        alias: "V",
        type: "string",
        describe: "Version to install",
      })
      .option("dry-run", {
        type: "boolean",
        describe: "Show what would be installed without actually installing",
        default: false,
      }),
  handler: async (argv) => {
    await ready

    const targets = argv.software as string[]
    const ctx = createContext()
    const version = argv.ver as string | undefined
    const dryRun = argv["dry-run"] as boolean

    for (const name of targets) {
      const installer = Registry.get(name)
      if (!installer) {
        Log.error(`Unknown software: ${name}`)
        Log.info(`Available: ${Registry.names().join(", ")}`)
        continue
      }

      console.log()
      console.log(chalk.bold(`📦 ${installer.name}`) + chalk.gray(` — ${installer.description}`))

      // Detect current state
      const spinner = ora("Checking current installation...").start()
      const current = await installer.detect(ctx)

      if (current.installed) {
        spinner.info(`Already installed: ${chalk.green(current.version)} at ${chalk.gray(current.path || "?")}`)

        if (!version) {
          Log.info("Skipping (already installed). Use --version to install a specific version.")
          continue
        }
      } else {
        spinner.info("Not currently installed")
      }

      if (dryRun) {
        Log.info(`[dry-run] Would install ${name}${version ? `@${version}` : ""}`)
        continue
      }

      // Parse parameters with defaults + any version override
      const params = installer.parameters.parse({
        ...(version ? { version } : {}),
      })

      // Install
      const installSpinner = ora(`Installing ${name}...`).start()
      try {
        const result = await installer.install(params, ctx)

        if (result.success) {
          installSpinner.succeed(chalk.green(result.message || `${name} installed successfully`))

          // Verify
          const verifySpinner = ora("Verifying installation...").start()
          const verified = await installer.verify(ctx)
          if (verified.installed) {
            verifySpinner.succeed(`Verified: ${chalk.green(verified.version)}`)
          } else {
            verifySpinner.warn("Installation may require a shell restart to take effect")
          }

          // Post-install hints
          if (result.postInstall?.length) {
            console.log()
            console.log(chalk.yellow("  Post-install steps:"))
            for (const step of result.postInstall) {
              console.log(chalk.gray(`    → ${step}`))
            }
          }
        } else {
          installSpinner.fail(chalk.red(result.message || `Failed to install ${name}`))
        }
      } catch (err) {
        installSpinner.fail(
          chalk.red(`Installation failed: ${err instanceof Error ? err.message : String(err)}`),
        )
        Log.info("Tip: Run `envready chat` to get AI help troubleshooting this issue")
      }
    }

    console.log()
  },
}
