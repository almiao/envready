import type { CommandModule } from "yargs"
import chalk from "chalk"
import { createInterface } from "readline"
import { AI } from "../../ai/agent"
import { OS } from "../../detect/os"
import { Software } from "../../detect/software"
import { Env } from "../../detect/env"
import { Log } from "../../util/log"

export const ChatCommand: CommandModule = {
  command: "chat [message..]",
  describe: "Chat with AI to troubleshoot and configure your environment",
  builder: (yargs) =>
    yargs.positional("message", {
      describe: "Initial message (enters interactive mode if omitted)",
      type: "string",
      array: true,
    }),
  handler: async (argv) => {
    Log.stage("Chat:start")
    const modelConfig = AI.resolve()
    if (!modelConfig) return

    const systemContext = gatherContext()
    Log.fileData("chat:systemContext", systemContext)
    const agent = new AI(modelConfig, systemContext)

    const initial = (argv.message as string[] | undefined)?.join(" ")

    if (initial) {
      Log.stage("Chat:single", initial)
      const response = await agent.chat(initial)
      console.log()
      console.log(response)
      console.log()
      return
    }

    // Interactive mode
    console.log()
    console.log(chalk.cyan("🤖 envready AI assistant"))
    console.log(chalk.gray(`   Model: ${modelConfig.provider}/${modelConfig.model}`))
    console.log(chalk.gray("   Ask me anything about installing or configuring software."))
    console.log(chalk.gray('   Type "exit" or Ctrl+C to quit.'))
    console.log()

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan("you > "),
    })

    rl.prompt()

    rl.on("line", async (line) => {
      const input = line.trim()
      if (!input) {
        rl.prompt()
        return
      }
      if (input === "exit" || input === "quit") {
        rl.close()
        return
      }

      try {
        const response = await agent.chat(input)
        console.log()
        console.log(chalk.green("ai >"), response)
        console.log()
      } catch (err) {
        Log.error(`AI error: ${err instanceof Error ? err.message : String(err)}`)
      }

      rl.prompt()
    })

    rl.on("close", () => {
      console.log(chalk.gray("\nGoodbye!"))
      process.exit(0)
    })
  },
}

function gatherContext(): string {
  const os = OS.detect()
  const software = Software.detect()
  const env = Env.summary()

  return `当前系统：
- OS: ${os.name} ${os.version} (${os.arch})
- Shell: ${os.shell}
- 包管理器: ${OS.packageManagers().join(", ") || "无"}
- 已安装软件: ${software.map((s) => `${s.name}@${s.version}`).join(", ") || "无"}
- 关键环境变量: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(", ")}
- Shell profile: ${Env.shellProfile()}
`
}
