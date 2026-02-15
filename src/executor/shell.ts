import { execSync, exec as execCb, spawn } from "child_process"

export namespace Shell {
  export interface Options {
    cwd?: string
    timeout?: number
    env?: Record<string, string>
  }

  export interface StreamOptions extends Options {
    /** Prefix for each output line (e.g. "  ") */
    prefix?: string
    /** If true, pipe stderr to terminal as well (default: true) */
    stderr?: boolean
    /** If true, output is shown live. If false, captured only (default: true) */
    live?: boolean
    /** AbortController signal to cancel the process */
    signal?: AbortSignal
    /** Callback on each line of output */
    onLine?: (line: string, stream: "stdout" | "stderr") => void
  }

  export interface StreamResult {
    stdout: string
    stderr: string
    code: number | null
  }

  /** Execute a shell command and return stdout (buffered, no live output) */
  export async function exec(cmd: string, opts?: Options): Promise<string> {
    return new Promise((resolve, reject) => {
      execCb(
        cmd,
        {
          encoding: "utf-8",
          timeout: opts?.timeout ?? 30_000,
          cwd: opts?.cwd,
          env: { ...process.env, ...opts?.env },
          shell: process.env.SHELL || "/bin/sh",
        },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`Command failed: ${cmd}\n${stderr || err.message}`))
          resolve(stdout)
        },
      )
    })
  }

  /**
   * Execute a command with real-time streaming output.
   *
   * Uses child_process.spawn so stdout/stderr are piped to the terminal
   * line by line, giving the user live feedback (download progress, build output, etc.)
   *
   * Returns the full captured output when the command finishes.
   *
   * Supports:
   * - Live output with optional prefix
   * - Ctrl+C / AbortSignal to kill the process
   * - Timeout
   * - onLine callback for custom processing
   */
  export function stream(cmd: string, opts?: StreamOptions): Promise<StreamResult> {
    const o = opts || {}
    const showLive = o.live !== false
    const showStderr = o.stderr !== false
    const prefix = o.prefix || ""
    const shell = process.env.SHELL || "/bin/sh"

    return new Promise((resolve, reject) => {
      const proc = spawn(shell, ["-c", cmd], {
        cwd: o.cwd,
        env: { ...process.env, ...o.env },
        stdio: ["inherit", "pipe", "pipe"], // stdin inherited (for interactive), stdout/stderr piped
      })

      let stdout = ""
      let stderr = ""
      let killed = false
      let timer: ReturnType<typeof setTimeout> | undefined

      // Timeout
      if (o.timeout && o.timeout > 0) {
        timer = setTimeout(() => {
          killed = true
          proc.kill("SIGTERM")
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL")
          }, 3000)
        }, o.timeout)
      }

      // AbortSignal
      if (o.signal) {
        if (o.signal.aborted) {
          proc.kill("SIGTERM")
          killed = true
        } else {
          o.signal.addEventListener("abort", () => {
            killed = true
            proc.kill("SIGTERM")
            setTimeout(() => {
              if (!proc.killed) proc.kill("SIGKILL")
            }, 3000)
          }, { once: true })
        }
      }

      proc.stdout!.on("data", (chunk: Buffer) => {
        const text = chunk.toString()
        stdout += text
        if (showLive) writeChunk(text, prefix)
        if (o.onLine) {
          for (const line of text.split("\n")) {
            if (line.trim()) o.onLine(line, "stdout")
          }
        }
      })

      proc.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString()
        stderr += text
        if (showLive && showStderr) writeChunk(text, prefix)
        if (o.onLine) {
          for (const line of text.split("\n")) {
            if (line.trim()) o.onLine(line, "stderr")
          }
        }
      })

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer)
        reject(new Error(`Command spawn failed: ${cmd}\n${err.message}`))
      })

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer)

        if (killed && code !== 0) {
          reject(new Error(`Command killed (${o.signal?.aborted ? "aborted" : "timeout"}): ${cmd}`))
          return
        }

        if (code !== 0) {
          reject(new Error(`Command failed (exit ${code}): ${cmd}\n${stderr.slice(-500)}`))
          return
        }

        resolve({ stdout, stderr, code })
      })
    })
  }

  /** Execute a command synchronously */
  export function execSync(cmd: string, opts?: Options): string {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: opts?.timeout ?? 30_000,
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      shell: process.env.SHELL || "/bin/sh",
    }) as string
  }

  /** Check if a command exists */
  export async function has(cmd: string): Promise<boolean> {
    try {
      await exec(`which ${cmd} 2>/dev/null`)
      return true
    } catch {
      return false
    }
  }

  /**
   * Write a chunk to stderr with optional prefix, preserving \r (progress bars).
   *
   * curl/wget progress bars use \r to overwrite the same line.
   * We must NOT convert \r into \n or the progress bar breaks into fragments.
   *
   * Strategy:
   * - No prefix → pass through raw (preserves all control characters)
   * - Has prefix → split by \n for real newlines; within each segment,
   *   handle \r by writing prefix + last \r-segment (simulating overwrite)
   */
  function writeChunk(text: string, prefix: string) {
    if (!prefix) {
      process.stderr.write(text)
      return
    }

    // Split by real newlines
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (i > 0) process.stderr.write("\n") // actual newline between lines

      if (!line) continue

      // Within a line, \r means "go back to start of line" (progress bar)
      if (line.includes("\r")) {
        const segments = line.split("\r")
        // Only show the last non-empty segment (what would be visible after \r overwrites)
        const visible = segments.filter((s) => s).pop() || ""
        if (visible) process.stderr.write(`\r${prefix}${visible}`)
      } else {
        process.stderr.write(`${prefix}${line}`)
      }
    }
  }
}
