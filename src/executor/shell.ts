import { execSync, exec as execCb, spawn } from "child_process"

export namespace Shell {
  export interface Options {
    cwd?: string
    timeout?: number
    env?: Record<string, string>
    /** Run in a login shell (-l) so .zshrc/.bash_profile are loaded */
    login?: boolean
  }

  /** Info passed to the stall handler so it (or AI) can make an informed decision */
  export interface StallInfo {
    /** The command being executed */
    cmd: string
    /** Total elapsed time since process started (ms) */
    elapsed: number
    /** How many times stall has been detected for this process */
    stallCount: number
    /** Last ~10 lines of combined output */
    lastOutput: string
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
    /**
     * Stall detection interval in ms. If no output for this long, onStall is called.
     * Default: 0 (disabled). Recommended: 120_000 (2 min) for installs.
     */
    stallTimeout?: number
    /**
     * Called when process produces no output for stallTimeout ms.
     * Return "wait" to keep waiting (timer resets), "kill" to terminate.
     * If not provided and stallTimeout is set, defaults to killing the process.
     */
    onStall?: (info: StallInfo) => Promise<"wait" | "kill">
  }

  /** Error thrown when a process produces no output and onStall says "kill" */
  export class StallError extends Error {
    elapsed: number
    stallCount: number
    constructor(cmd: string, elapsed: number, stallCount: number) {
      super(`Process stalled (no output, total ${Math.round(elapsed / 1000)}s, stall #${stallCount}): ${cmd.slice(0, 120)}`)
      this.name = "StallError"
      this.elapsed = elapsed
      this.stallCount = stallCount
    }
  }

  export interface StreamResult {
    stdout: string
    stderr: string
    code: number | null
  }

  /** Execute a shell command and return stdout (buffered, no live output) */
  export async function exec(cmd: string, opts?: Options): Promise<string> {
    const shell = process.env.SHELL || "/bin/sh"
    // Login shell: uses -l -c so .zshrc/.bash_profile are sourced,
    // making freshly-installed tools (sdkman, nvm, etc.) available
    const actualCmd = opts?.login ? `${shell} -l -c ${quote(cmd)}` : cmd
    return new Promise((resolve, reject) => {
      execCb(
        actualCmd,
        {
          encoding: "utf-8",
          timeout: opts?.timeout ?? 30_000,
          cwd: opts?.cwd,
          env: { ...process.env, ...opts?.env },
          shell,
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
      const args = o.login ? ["-l", "-c", cmd] : ["-c", cmd]
      const proc = spawn(shell, args, {
        cwd: o.cwd,
        env: { ...process.env, ...o.env },
        stdio: ["inherit", "pipe", "pipe"], // stdin inherited (for interactive), stdout/stderr piped
      })

      let stdout = ""
      let stderr = ""
      let killed = false
      let stalled = false
      let stallCount = 0
      const startTime = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      let stallTimer: ReturnType<typeof setTimeout> | undefined

      // Collect last N lines for stall diagnostics
      const outputLines: string[] = []
      const trackLine = (text: string) => {
        for (const line of text.split("\n")) {
          if (line.trim()) {
            outputLines.push(line.trim())
            if (outputLines.length > 10) outputLines.shift()
          }
        }
      }

      const resetStallTimer = () => {
        if (!o.stallTimeout || o.stallTimeout <= 0) return
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(async () => {
          stallCount++
          const info: StallInfo = {
            cmd,
            elapsed: Date.now() - startTime,
            stallCount,
            lastOutput: outputLines.join("\n"),
          }

          // Ask the handler (AI or default) what to do
          let decision: "wait" | "kill" = "kill"
          if (o.onStall) {
            try {
              decision = await o.onStall(info)
            } catch {
              decision = "kill" // if handler fails, kill
            }
          }

          if (decision === "wait") {
            // Reset and wait another cycle
            resetStallTimer()
          } else {
            stalled = true
            killed = true
            proc.kill("SIGTERM")
            setTimeout(() => {
              if (!proc.killed) proc.kill("SIGKILL")
            }, 3000)
          }
        }, o.stallTimeout)
      }

      // Start stall detection
      resetStallTimer()

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
        trackLine(text)
        resetStallTimer()
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
        trackLine(text)
        resetStallTimer()
        if (showLive && showStderr) writeChunk(text, prefix)
        if (o.onLine) {
          for (const line of text.split("\n")) {
            if (line.trim()) o.onLine(line, "stderr")
          }
        }
      })

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer)
        if (stallTimer) clearTimeout(stallTimer)
        reject(new Error(`Command spawn failed: ${cmd}\n${err.message}`))
      })

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer)
        if (stallTimer) clearTimeout(stallTimer)

        if (stalled) {
          reject(new StallError(cmd, Date.now() - startTime, stallCount))
          return
        }

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

  /**
   * Run multiple commands in a single shell session.
   *
   * All commands execute in ONE shell process, so environment changes
   * (source, export, eval) persist between commands. This solves the
   * classic problem where tools like sdkman/nvm/pyenv need to be sourced
   * before they can be used.
   *
   * Each command gets a step indicator in the output:
   *   ▶ [1/3] curl -s https://get.sdkman.io | bash
   *   ▶ [2/3] source ~/.sdkman/bin/sdkman-init.sh
   *   ▶ [3/3] sdk install java 23.0.1-tem
   *
   * On error, stops at the failing command (set -e behavior).
   */
  export function session(commands: string[], opts?: StreamOptions): Promise<StreamResult> {
    if (commands.length === 0) return Promise.resolve({ stdout: "", stderr: "", code: 0 })
    if (commands.length === 1) return stream(commands[0]!, opts)

    // Build a shell script that:
    // 1. Runs each command in sequence
    // 2. Shows a step indicator before each command
    // 3. Stops on first failure (set -e)
    // 4. Preserves environment between commands
    // 5. Tracks which command failed for clean error reporting
    const lines: string[] = [
      "set -e",
      "_envready_step=0",
    ]

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!
      const display = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd
      const safe = display.replace(/'/g, "'\\''")
      lines.push(`_envready_step=${i + 1}`)
      lines.push(`echo '  ▶ [${i + 1}/${commands.length}] ${safe}'`)
      lines.push(cmd)
    }

    const script = lines.join("\n")

    // Wrap stream() to clean up error messages — hide internal script, show only the failing command
    return stream(script, opts).catch((err) => {
      if (err instanceof Error) {
        // Extract the actual stderr (last part after the script dump)
        const stderr = err.message
        // Clean: remove the internal "set -e\necho...\n" script from error message
        const cleaned = stderr
          .replace(/Command failed \(exit \d+\): set -e[\s\S]*?\n(?=\S)/, (match) => {
            const exitMatch = match.match(/exit (\d+)/)
            return `Command failed (exit ${exitMatch?.[1] || "?"}): `
          })
          .replace(/set -e\n/g, "")
          .replace(/_envready_step=\d+\n/g, "")
          .replace(/echo '.*?'\n/g, "")

        err.message = cleaned
      }
      throw err
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

  /** Shell-safe single-quote a string */
  function quote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
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
