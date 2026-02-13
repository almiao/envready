import { existsSync, readFileSync } from "fs"
import { join } from "path"
import YAML from "yaml"
import { EnvreadyConfig, ModelConfig } from "./schema"

const CONFIG_NAMES = ["envready.yaml", "envready.yml", "envready.json", ".envready.yaml", ".envready.yml"]

export namespace Config {
  /** Find and load config from a directory (walks up to find it) */
  export function load(dir?: string): EnvreadyConfig | null {
    const cwd = dir || process.cwd()
    let current = cwd

    while (true) {
      for (const name of CONFIG_NAMES) {
        const filepath = join(current, name)
        if (existsSync(filepath)) return parse(filepath)
      }

      const parent = join(current, "..")
      if (parent === current) break
      current = parent
    }

    return null
  }

  /** Parse a config file */
  export function parse(filepath: string): EnvreadyConfig {
    const content = readFileSync(filepath, "utf-8")

    let raw: unknown
    if (filepath.endsWith(".json")) {
      raw = JSON.parse(content)
    } else {
      raw = YAML.parse(content)
    }

    return EnvreadyConfig.parse(raw)
  }

  /** Get the global config directory */
  export function globalDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME
    if (xdg) return join(xdg, "envready")
    const home = process.env.HOME || process.env.USERPROFILE || "~"
    return join(home, ".config", "envready")
  }

  /** Load global config (~/.config/envready/config.yaml) */
  export function loadGlobal(): EnvreadyConfig | null {
    const dir = globalDir()
    for (const name of ["config.yaml", "config.yml", "config.json"]) {
      const filepath = join(dir, name)
      if (existsSync(filepath)) return parse(filepath)
    }
    return null
  }

  /**
   * Resolve model config with priority:
   * 1. Project config (envready.yaml in cwd)
   * 2. Global config (~/.config/envready/config.yaml)
   * 3. Environment variables
   * 4. Defaults
   */
  export function resolveModel(): ModelConfig | null {
    // Try project config
    const project = load()
    if (project?.model) return resolveEnvVars(project.model)

    // Try global config
    const global = loadGlobal()
    if (global?.model) return resolveEnvVars(global.model)

    // Try environment variables
    const apiKey =
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.DEEPSEEK_API_KEY

    if (!apiKey) return null

    // Infer provider from available key
    if (process.env.ANTHROPIC_API_KEY) {
      return {
        provider: "anthropic",
        model: process.env.ENVREADY_MODEL || "claude-sonnet-4-20250514",
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseURL: process.env.ENVREADY_BASE_URL,
      }
    }

    if (process.env.DEEPSEEK_API_KEY) {
      return {
        provider: "deepseek",
        model: process.env.ENVREADY_MODEL || "deepseek-chat",
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: process.env.ENVREADY_BASE_URL || "https://api.deepseek.com/v1",
      }
    }

    return {
      provider: "openai",
      model: process.env.ENVREADY_MODEL || "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.ENVREADY_BASE_URL,
    }
  }

  /** Replace ${ENV_VAR} references in apiKey/baseURL */
  function resolveEnvVars(config: ModelConfig): ModelConfig {
    const resolve = (val?: string): string | undefined => {
      if (!val) return val
      return val.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "")
    }
    return {
      ...config,
      apiKey: resolve(config.apiKey),
      baseURL: resolve(config.baseURL),
    }
  }
}
