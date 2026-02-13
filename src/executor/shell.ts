import { execSync, exec as execCb } from "child_process"

export namespace Shell {
  export interface Options {
    cwd?: string
    timeout?: number
    env?: Record<string, string>
  }

  /** Execute a shell command and return stdout */
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
}
