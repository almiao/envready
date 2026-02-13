import { execSync } from "child_process"

export namespace Software {
  export interface Detected {
    name: string
    version: string
    path: string
  }

  const PROBES: Record<string, { cmd: string; parse: (out: string) => string }> = {
    node: {
      cmd: "node --version",
      parse: (out) => out.replace("v", "").trim(),
    },
    npm: {
      cmd: "npm --version",
      parse: (out) => out.trim(),
    },
    pnpm: {
      cmd: "pnpm --version",
      parse: (out) => out.trim(),
    },
    bun: {
      cmd: "bun --version",
      parse: (out) => out.trim(),
    },
    python: {
      cmd: "python3 --version || python --version",
      parse: (out) => out.replace("Python ", "").trim(),
    },
    pip: {
      cmd: "pip3 --version || pip --version",
      parse: (out) => {
        const match = out.match(/pip (\S+)/)
        return match?.[1] ?? out.trim()
      },
    },
    go: {
      cmd: "go version",
      parse: (out) => {
        const match = out.match(/go(\d+\.\d+(\.\d+)?)/)
        return match?.[1] ?? out.trim()
      },
    },
    rust: {
      cmd: "rustc --version",
      parse: (out) => {
        const match = out.match(/rustc (\S+)/)
        return match?.[1] ?? out.trim()
      },
    },
    cargo: {
      cmd: "cargo --version",
      parse: (out) => {
        const match = out.match(/cargo (\S+)/)
        return match?.[1] ?? out.trim()
      },
    },
    docker: {
      cmd: "docker --version",
      parse: (out) => {
        const match = out.match(/Docker version (\S+),/)
        return match?.[1] ?? out.trim()
      },
    },
    git: {
      cmd: "git --version",
      parse: (out) => {
        const match = out.match(/git version (\S+)/)
        return match?.[1] ?? out.trim()
      },
    },
    java: {
      cmd: "java -version 2>&1",
      parse: (out) => {
        const match = out.match(/version "(.+?)"/)
        return match?.[1] ?? out.trim()
      },
    },
    ruby: {
      cmd: "ruby --version",
      parse: (out) => {
        const match = out.match(/ruby (\S+)/)
        return match?.[1] ?? out.trim()
      },
    },
    php: {
      cmd: "php --version",
      parse: (out) => {
        const match = out.match(/PHP (\S+)/)
        return match?.[1] ?? out.trim()
      },
    },
  }

  function which(name: string): string {
    try {
      return execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8" }).trim()
    } catch {
      return ""
    }
  }

  export function detect(names?: string[]): Detected[] {
    const targets = names ?? Object.keys(PROBES)
    const results: Detected[] = []

    for (const name of targets) {
      const probe = PROBES[name]
      if (!probe) continue

      try {
        const out = execSync(probe.cmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] })
        results.push({
          name,
          version: probe.parse(out),
          path: which(name),
        })
      } catch {
        // not installed, skip
      }
    }

    return results
  }

  export function isInstalled(name: string): boolean {
    const probe = PROBES[name]
    if (!probe) return which(name) !== ""
    try {
      execSync(probe.cmd, { encoding: "utf-8", timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  export const SUPPORTED = Object.keys(PROBES)
}
