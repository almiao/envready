import { z } from "zod"
import { Installer } from "../installer"

export default Installer.define({
  name: "go",
  description: "Go programming language",
  homepage: "https://go.dev",
  tags: ["go", "golang", "backend", "systems"],
  parameters: z.object({
    version: z.string().default("latest").describe("Go version (e.g. 1.22, latest)"),
  }),
  async detect(ctx) {
    try {
      const out = await ctx.exec("go version")
      const match = out.match(/go(\d+\.\d+(\.\d+)?)/)
      const version = match?.[1] ?? out.trim()
      const path = (await ctx.exec("which go")).trim()
      return { installed: true, version, path }
    } catch {
      return { installed: false }
    }
  },
  async install(args, ctx) {
    const { version } = args

    if (ctx.platform === "darwin") {
      ctx.log("Installing Go via Homebrew...")
      await ctx.exec("brew install go")
      return { success: true, message: "Go installed via Homebrew" }
    }

    if (ctx.platform === "linux") {
      ctx.log("Installing Go from official tarball...")
      // Determine the download URL
      const goVersion =
        version === "latest"
          ? (await ctx.exec("curl -sL https://go.dev/VERSION?m=text")).split("\n")[0]!
          : `go${version}`
      const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" }
      const arch = archMap[ctx.arch] || "amd64"
      const url = `https://go.dev/dl/${goVersion}.linux-${arch}.tar.gz`

      await ctx.exec("sudo rm -rf /usr/local/go")
      await ctx.exec(`curl -sL ${url} | sudo tar -C /usr/local -xzf -`)

      return {
        success: true,
        message: `${goVersion} installed to /usr/local/go`,
        postInstall: ['Add to PATH: export PATH=$PATH:/usr/local/go/bin'],
      }
    }

    return {
      success: false,
      message: "Please download Go from https://go.dev/dl/",
    }
  },
  async verify(ctx) {
    return this.detect(ctx)
  },
})
