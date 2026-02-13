import { z } from "zod"
import { Installer } from "../installer"

export default Installer.define({
  name: "node",
  description: "Node.js JavaScript runtime (via fnm or nvm)",
  homepage: "https://nodejs.org",
  tags: ["javascript", "typescript", "runtime", "frontend", "backend"],
  parameters: z.object({
    version: z.string().default("lts").describe("Node.js version (e.g. 20, lts, latest)"),
    manager: z
      .enum(["fnm", "nvm"])
      .default("fnm")
      .describe("Version manager to use"),
  }),
  async detect(ctx) {
    try {
      const version = (await ctx.exec("node --version")).replace("v", "").trim()
      const path = (await ctx.exec("which node")).trim()
      return { installed: true, version, path }
    } catch {
      return { installed: false }
    }
  },
  async install(args, ctx) {
    const { version, manager } = args

    // Check if version manager is installed
    if (manager === "fnm") {
      try {
        await ctx.exec("fnm --version")
      } catch {
        ctx.log("Installing fnm (Fast Node Manager)...")
        if (ctx.platform === "darwin") {
          try {
            await ctx.exec("brew install fnm")
          } catch {
            await ctx.exec("curl -fsSL https://fnm.vercel.app/install | bash")
          }
        } else if (ctx.platform === "linux") {
          await ctx.exec("curl -fsSL https://fnm.vercel.app/install | bash")
        } else {
          return { success: false, message: "Please install fnm manually: https://github.com/Schniz/fnm" }
        }
      }
      ctx.log(`Installing Node.js ${version} via fnm...`)
      const target = version === "lts" ? "--lts" : version
      await ctx.exec(`fnm install ${target}`)
      await ctx.exec(`fnm use ${target}`)
      await ctx.exec(`fnm default ${target}`)
    }

    if (manager === "nvm") {
      try {
        await ctx.exec("bash -c 'source $NVM_DIR/nvm.sh && nvm --version'")
      } catch {
        ctx.log("Installing nvm (Node Version Manager)...")
        await ctx.exec(
          "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash",
        )
      }
      ctx.log(`Installing Node.js ${version} via nvm...`)
      const target = version === "lts" ? "--lts" : version
      await ctx.exec(`bash -c 'source $NVM_DIR/nvm.sh && nvm install ${target}'`)
    }

    return { success: true, message: `Node.js ${version} installed via ${manager}` }
  },
  async verify(ctx) {
    return this.detect(ctx)
  },
})
