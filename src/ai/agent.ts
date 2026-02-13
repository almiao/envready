import { generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"

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

You have access to the user's system information which will be provided as context.`

export class AI {
  private client: ReturnType<typeof createOpenAI>
  private systemContext: string
  private history: Array<{ role: "user" | "assistant"; content: string }> = []

  constructor(apiKey: string, systemContext: string) {
    this.client = createOpenAI({ apiKey })
    this.systemContext = systemContext
  }

  async chat(message: string): Promise<string> {
    this.history.push({ role: "user", content: message })

    const result = await generateText({
      model: this.client("gpt-4o-mini"),
      system: `${SYSTEM_PROMPT}\n\n${this.systemContext}`,
      messages: this.history,
    })

    const response = result.text
    this.history.push({ role: "assistant", content: response })

    return response
  }

  reset() {
    this.history = []
  }
}
