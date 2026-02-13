import { existsSync, readFileSync } from "fs"
import { join } from "path"
import YAML from "yaml"
import { EnvreadyConfig } from "./schema"

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
}
