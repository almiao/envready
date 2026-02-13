import { z } from "zod"

export const ModelConfig = z.object({
  provider: z
    .enum(["openai", "anthropic", "ollama", "deepseek", "openai-compatible"])
    .default("openai")
    .describe("LLM provider"),
  model: z.string().default("gpt-4o-mini").describe("Model name"),
  apiKey: z.string().optional().describe("API key (can use env var reference like ${OPENAI_API_KEY})"),
  baseURL: z.string().optional().describe("Custom API base URL (for proxy or OpenAI-compatible services)"),
})

export const ToolEntry = z.object({
  name: z.string(),
  version: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables to set after install"),
  service: z.boolean().optional().describe("Register as a managed service"),
  start_after_install: z.boolean().optional().describe("Start service after apply"),
})

export const HooksSchema = z.object({
  pre_install: z.array(z.string()).optional(),
  post_install: z.array(z.string()).optional(),
})

export const EnvreadyConfig = z.object({
  name: z.string().optional().describe("Environment name"),
  description: z.string().optional(),
  model: ModelConfig.optional().describe("LLM model configuration"),
  tools: z.array(ToolEntry).default([]),
  hooks: HooksSchema.optional(),
  env: z.record(z.string(), z.string()).optional().describe("Global environment variables to set"),
})

export type ModelConfig = z.infer<typeof ModelConfig>
export type EnvreadyConfig = z.infer<typeof EnvreadyConfig>
export type ToolEntry = z.infer<typeof ToolEntry>
