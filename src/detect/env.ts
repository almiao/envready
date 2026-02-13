export namespace Env {
  export interface PathInfo {
    path: string[]
    duplicates: string[]
    missing: string[]
  }

  export function analyzePath(): PathInfo {
    const { existsSync } = require("fs") as typeof import("fs")
    const raw = process.env.PATH || ""
    const sep = process.platform === "win32" ? ";" : ":"
    const parts = raw.split(sep).filter(Boolean)

    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const p of parts) {
      if (seen.has(p)) duplicates.push(p)
      seen.add(p)
    }

    const missing: string[] = []
    for (const p of parts) {
      if (!existsSync(p)) missing.push(p)
    }

    return { path: parts, duplicates, missing }
  }

  export function shellProfile(): string {
    const shell = process.env.SHELL || ""
    const home = process.env.HOME || "~"

    if (shell.includes("zsh")) return `${home}/.zshrc`
    if (shell.includes("bash")) {
      // macOS uses .bash_profile, Linux uses .bashrc
      if (process.platform === "darwin") return `${home}/.bash_profile`
      return `${home}/.bashrc`
    }
    if (shell.includes("fish")) return `${home}/.config/fish/config.fish`
    return `${home}/.profile`
  }

  export function summary(): Record<string, string | undefined> {
    const keys = [
      "HOME",
      "PATH",
      "SHELL",
      "LANG",
      "EDITOR",
      "GOPATH",
      "GOROOT",
      "JAVA_HOME",
      "PYTHON_HOME",
      "NVM_DIR",
      "RUSTUP_HOME",
      "CARGO_HOME",
      "DOCKER_HOST",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
    ]

    const result: Record<string, string | undefined> = {}
    for (const key of keys) {
      const val = process.env[key]
      if (val) result[key] = val
    }
    return result
  }
}
