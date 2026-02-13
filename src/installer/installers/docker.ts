import { z } from "zod"
import { Installer } from "../installer"

export default Installer.define({
  name: "docker",
  description: "Docker container runtime",
  homepage: "https://docker.com",
  tags: ["docker", "container", "devops", "infrastructure"],
  parameters: z.object({
    compose: z
      .boolean()
      .default(true)
      .describe("Also install Docker Compose"),
  }),
  async detect(ctx) {
    try {
      const out = await ctx.exec("docker --version")
      const match = out.match(/Docker version (\S+),/)
      const version = match?.[1] ?? out.trim()
      const path = (await ctx.exec("which docker")).trim()

      const details: Record<string, string> = {}
      try {
        const composeOut = await ctx.exec("docker compose version 2>/dev/null || docker-compose --version 2>/dev/null")
        details["compose"] = composeOut.trim()
      } catch {}

      // Check if Docker daemon is running
      try {
        await ctx.exec("docker info > /dev/null 2>&1")
        details["daemon"] = "running"
      } catch {
        details["daemon"] = "not running"
      }

      return { installed: true, version, path, details }
    } catch {
      return { installed: false }
    }
  },
  async install(_args, ctx) {
    if (ctx.platform === "darwin") {
      ctx.log("Docker Desktop is recommended for macOS.")
      ctx.log("Attempting install via Homebrew Cask...")
      try {
        await ctx.exec("brew install --cask docker")
        return {
          success: true,
          message: "Docker Desktop installed. Please open Docker.app to complete setup.",
          postInstall: ["Open Docker Desktop from Applications to start the daemon"],
        }
      } catch {
        return {
          success: false,
          message: "Please download Docker Desktop from https://docker.com/products/docker-desktop",
        }
      }
    }

    if (ctx.platform === "linux") {
      ctx.log("Installing Docker via official script...")
      await ctx.exec("curl -fsSL https://get.docker.com | sh")

      // Add current user to docker group
      const user = process.env.USER || ""
      if (user) {
        try {
          await ctx.exec(`sudo usermod -aG docker ${user}`)
        } catch {}
      }

      return {
        success: true,
        message: "Docker installed",
        postInstall: [
          "Log out and back in for group changes to take effect",
          "Or run: newgrp docker",
        ],
      }
    }

    return {
      success: false,
      message: "Please download Docker Desktop from https://docker.com/products/docker-desktop",
    }
  },
  async verify(ctx) {
    return this.detect(ctx)
  },
})
