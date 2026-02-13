import { execSync } from "child_process"

export namespace OS {
  export interface Info {
    platform: NodeJS.Platform
    arch: string
    name: string
    version: string
    shell: string
    home: string
    user: string
  }

  export function detect(): Info {
    const platform = process.platform
    const arch = process.arch
    const home = process.env.HOME || process.env.USERPROFILE || "~"
    const user = process.env.USER || process.env.USERNAME || "unknown"
    const shell = process.env.SHELL || process.env.COMSPEC || "unknown"

    let name = platform
    let version = ""

    if (platform === "darwin") {
      name = "macOS"
      try {
        version = execSync("sw_vers -productVersion", { encoding: "utf-8" }).trim()
      } catch {}
    }
    if (platform === "linux") {
      name = "Linux"
      try {
        const release = execSync("cat /etc/os-release 2>/dev/null || echo ''", { encoding: "utf-8" })
        const match = release.match(/PRETTY_NAME="(.+)"/)
        if (match?.[1]) name = match[1]
        const ver = release.match(/VERSION_ID="(.+)"/)
        if (ver?.[1]) version = ver[1]
      } catch {}
    }
    if (platform === "win32") {
      name = "Windows"
      try {
        version = execSync("ver", { encoding: "utf-8" }).trim()
      } catch {}
    }

    return { platform, arch, name, version, shell, home, user }
  }

  export function packageManagers(): string[] {
    const managers: string[] = []
    const check = (cmd: string) => {
      try {
        execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, { encoding: "utf-8" })
        return true
      } catch {
        return false
      }
    }

    if (check("brew")) managers.push("brew")
    if (check("apt")) managers.push("apt")
    if (check("apt-get")) managers.push("apt-get")
    if (check("dnf")) managers.push("dnf")
    if (check("yum")) managers.push("yum")
    if (check("pacman")) managers.push("pacman")
    if (check("winget")) managers.push("winget")
    if (check("choco")) managers.push("choco")
    if (check("nix")) managers.push("nix")
    if (check("snap")) managers.push("snap")

    return managers
  }
}
