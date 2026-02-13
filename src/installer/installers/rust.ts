import { z } from "zod"
import { Installer } from "../installer"

export default Installer.define({
  name: "rust",
  description: "Rust programming language (via rustup)",
  homepage: "https://www.rust-lang.org",
  tags: ["rust", "systems", "wasm", "performance"],
  parameters: z.object({
    toolchain: z
      .enum(["stable", "nightly", "beta"])
      .default("stable")
      .describe("Rust toolchain"),
  }),
  async detect(ctx) {
    try {
      const out = await ctx.exec("rustc --version")
      const match = out.match(/rustc (\S+)/)
      const version = match?.[1] ?? out.trim()
      const path = (await ctx.exec("which rustc")).trim()

      const details: Record<string, string> = {}
      try {
        const toolchain = (await ctx.exec("rustup show active-toolchain")).trim()
        details["toolchain"] = toolchain
      } catch {}

      return { installed: true, version, path, details }
    } catch {
      return { installed: false }
    }
  },
  async install(args, ctx) {
    const { toolchain } = args

    // Check if rustup exists
    try {
      await ctx.exec("rustup --version")
      ctx.log(`Updating Rust ${toolchain} toolchain...`)
      await ctx.exec(`rustup toolchain install ${toolchain}`)
      await ctx.exec(`rustup default ${toolchain}`)
    } catch {
      ctx.log("Installing Rust via rustup...")
      await ctx.exec(
        `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain ${toolchain}`,
      )
    }

    return {
      success: true,
      message: `Rust ${toolchain} installed via rustup`,
      postInstall: ['Source environment: source "$HOME/.cargo/env"'],
    }
  },
  async verify(ctx) {
    return this.detect(ctx)
  },
})
