import { generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import type { ModelConfig } from "../config/schema"
import { Config } from "../config/config"
import { Log } from "../util/log"

const SYSTEM_PROMPT = `You are envready AI assistant — an expert in software installation, configuration, and environment troubleshooting.

Your role:
1. Help users install and configure development tools
2. Diagnose and fix environment issues (PATH problems, version conflicts, permission errors, etc.)
3. Suggest best practices for environment setup
4. Provide step-by-step instructions that are safe and reversible

Rules:
- Always consider the user's OS and architecture when suggesting commands
- Prefer version managers (fnm, pyenv, rustup) over system package managers for dev tools
- Warn about destructive operations (sudo rm, overwriting configs, etc.)
- When suggesting PATH changes, specify the exact file to edit
- If unsure, ask clarifying questions rather than guessing
- Keep responses concise and actionable
- When outputting JSON, output ONLY the JSON without markdown code fences

You have access to the user's system information which will be provided as context.`

function createModel(config: ModelConfig) {
  const opts: Parameters<typeof createOpenAI>[0] = {}

  if (config.apiKey) opts.apiKey = config.apiKey

  if (config.baseURL) {
    opts.baseURL = config.baseURL
  } else if (config.provider === "deepseek") {
    opts.baseURL = "https://api.deepseek.com/v1"
  }

  const client = createOpenAI(opts)
  return client(config.model)
}

let callIndex = 0

export class AI {
  private model: ReturnType<typeof createModel>
  private config: ModelConfig
  private systemContext: string
  private history: Array<{ role: "user" | "assistant"; content: string }> = []

  constructor(config: ModelConfig, systemContext: string) {
    this.model = createModel(config)
    this.config = config
    this.systemContext = systemContext
    Log.modelConfig({ provider: config.provider, model: config.model, baseURL: config.baseURL })
    Log.prompt("system", `${SYSTEM_PROMPT}\n\n${systemContext}`)
  }

  async chat(message: string): Promise<string> {
    callIndex++
    const tag = `call#${callIndex}`

    this.history.push({ role: "user", content: message })

    Log.stage("AI:chat", tag)
    Log.prompt(tag, message)
    Log.file(`[AI:HISTORY] ${tag} history_length=${this.history.length}`)

    const start = Date.now()
    const result = await generateText({
      model: this.model,
      system: `${SYSTEM_PROMPT}\n\n${this.systemContext}`,
      messages: this.history,
    })
    const elapsed = Date.now() - start

    const response = result.text
    this.history.push({ role: "assistant", content: response })

    Log.response(tag, response)
    Log.file(`[AI:USAGE] ${tag} elapsed=${elapsed}ms prompt_tokens=${result.usage?.promptTokens ?? "?"} completion_tokens=${result.usage?.completionTokens ?? "?"} total_tokens=${result.usage?.totalTokens ?? "?"}`)

    return response
  }

  reset() {
    this.history = []
  }

  /**
   * Resolve model config, or return null with error message
   */
  static resolve(): ModelConfig | null {
    Log.stage("Model:resolve")
    const config = Config.resolveModel()
    if (!config) {
      Log.file("[MODEL:RESOLVE] No model config found")
      Log.error("未找到模型配置")
      Log.blank()
      Log.info("请通过以下任一方式配置：")
      Log.info("")
      Log.info("  方式 1：环境变量")
      Log.info("    export OPENAI_API_KEY=sk-...")
      Log.info("")
      Log.info("  方式 2：全局配置文件 (~/.config/envready/config.yaml)")
      Log.info("    model:")
      Log.info("      provider: openai")
      Log.info("      model: gpt-4o-mini")
      Log.info("      apiKey: sk-...")
      Log.info("")
      Log.info("  方式 3：项目配置文件 (envready.yaml)")
      Log.info("    model:")
      Log.info("      provider: deepseek")
      Log.info("      model: deepseek-chat")
      Log.info("      apiKey: ${DEEPSEEK_API_KEY}")
      Log.info("")
      Log.info("  详见: envready --help 或 DESIGN.md")
      return null
    }

    if (!config.apiKey) {
      Log.file(`[MODEL:RESOLVE] provider=${config.provider} but missing apiKey`)
      Log.error(`模型 provider=${config.provider} 已配置，但缺少 apiKey`)
      Log.info("请设置对应的 API Key 环境变量或在配置文件中指定")
      return null
    }

    Log.file(`[MODEL:RESOLVE] OK provider=${config.provider} model=${config.model} baseURL=${config.baseURL || "(default)"}`)
    return config
  }
}
