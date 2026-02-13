import { z } from "zod"

export namespace Installer {
  export interface Context {
    platform: NodeJS.Platform
    arch: string
    shell: string
    home: string
    /** log a progress message */
    log: (msg: string) => void
    /** execute a shell command, returns stdout */
    exec: (cmd: string) => Promise<string>
  }

  export interface DetectResult {
    installed: boolean
    version?: string
    path?: string
    details?: Record<string, string>
  }

  export interface InstallResult {
    success: boolean
    version?: string
    message?: string
    postInstall?: string[]
  }

  export interface Info<P extends z.ZodType = z.ZodType> {
    name: string
    description: string
    homepage: string
    tags: string[]
    parameters: P
    detect(ctx: Context): Promise<DetectResult>
    install(args: z.infer<P>, ctx: Context): Promise<InstallResult>
    verify(ctx: Context): Promise<DetectResult>
    uninstall?(ctx: Context): Promise<{ success: boolean; message?: string }>
  }

  export function define<P extends z.ZodType>(info: Info<P>): Info<P> {
    return info
  }
}
