import { z } from "zod"

export const ToolEntry = z.object({
  name: z.string(),
  version: z.string().optional(),
  config: z.record(z.string(), z.any()).optional(),
})

export const HooksSchema = z.object({
  pre_install: z.array(z.string()).optional(),
  post_install: z.array(z.string()).optional(),
})

export const EnvreadyConfig = z.object({
  name: z.string().optional().describe("Environment name"),
  description: z.string().optional(),
  tools: z.array(ToolEntry).default([]),
  hooks: HooksSchema.optional(),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables to set"),
})

export type EnvreadyConfig = z.infer<typeof EnvreadyConfig>
export type ToolEntry = z.infer<typeof ToolEntry>
