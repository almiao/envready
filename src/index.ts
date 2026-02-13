#!/usr/bin/env bun
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { DetectCommand } from "./cli/cmd/detect"
import { InstallCommand } from "./cli/cmd/install"
import { ListCommand } from "./cli/cmd/list"
import { ApplyCommand } from "./cli/cmd/apply"
import { ChatCommand } from "./cli/cmd/chat"
import { UI } from "./cli/ui"
import { Log } from "./util/log"

// Initialize file logging immediately
Log.init()

const cli = yargs(hideBin(process.argv))
  .scriptName("envready")
  .wrap(100)
  .help("help", "Show help")
  .alias("help", "h")
  .version("0.1.0")
  .alias("version", "v")
  .option("verbose", {
    type: "boolean",
    describe: "Enable verbose output (debug logs to stderr + log file)",
    default: false,
  })
  .middleware((opts) => {
    if (opts.verbose) Log.setLevel("debug")
    Log.debug(`Log file: ${Log.logFilePath()}`)
  })
  .usage(UI.logo())
  .command(DetectCommand)
  .command(InstallCommand)
  .command(ListCommand)
  .command(ApplyCommand)
  .command(ChatCommand)
  .demandCommand(1, "Please specify a command. Run --help for usage.")
  .strict()

try {
  await cli.parse()
} catch (err) {
  if (err instanceof Error) {
    Log.error(err.message)
    Log.debug(err.stack || "")
  } else {
    Log.error(String(err))
  }
  const logPath = Log.logFilePath()
  if (logPath) Log.file(`[FATAL] ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
}
