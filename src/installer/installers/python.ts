import { z } from "zod"
import { Installer } from "../installer"

export default Installer.define({
  name: "python",
  description: "Python programming language (via pyenv)",
  homepage: "https://python.org",
  tags: ["python", "scripting", "data-science", "ml", "backend"],
  parameters: z.object({
    version: z.string().default("3").describe("Python version (e.g. 3.12, 3)"),
    manager: z
      .enum(["pyenv", "system"])
      .default("pyenv")
      .describe("Installation method"),
  }),
  async detect(ctx) {
    try {
      const out = await ctx.exec("python3 --version 2>&1 || python --version 2>&1")
      const version = out.replace("Python ", "").trim()
      const path = (await ctx.exec("which python3 2>/dev/null || which python")).trim()
      return { installed: true, version, path }
    } catch {
      return { installed: false }
    }
  },
  async install(args, ctx) {
    const { version, manager } = args

    if (manager === "pyenv") {
      try {
        await ctx.exec("pyenv --version")
      } catch {
        ctx.log("Installing pyenv...")
        if (ctx.platform === "darwin") {
          await ctx.exec("brew install pyenv")
        } else if (ctx.platform === "linux") {
          await ctx.exec("curl https://pyenv.run | bash")
        } else {
          return { success: false, message: "Please install pyenv manually: https://github.com/pyenv/pyenv" }
        }
      }

      ctx.log(`Installing Python ${version} via pyenv...`)
      // Find latest matching version
      const available = await ctx.exec(`pyenv install --list | grep -E "^\\s+${version}" | tail -1`)
      const target = available.trim() || version
      await ctx.exec(`pyenv install -s ${target}`)
      await ctx.exec(`pyenv global ${target}`)

      return {
        success: true,
        message: `Python ${target} installed via pyenv`,
        postInstall: [
          'Add to your shell profile: eval "$(pyenv init -)"',
        ],
      }
    }

    // System package manager
    if (ctx.platform === "darwin") {
      await ctx.exec("brew install python@3")
    } else if (ctx.platform === "linux") {
      await ctx.exec("sudo apt-get install -y python3 python3-pip || sudo dnf install -y python3 python3-pip")
    }

    return { success: true, message: "Python installed via system package manager" }
  },
  async verify(ctx) {
    return this.detect(ctx)
  },
})
