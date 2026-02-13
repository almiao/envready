import { Shell } from "./shell"
import { Log } from "../util/log"
import path from "path"
import fs from "fs"

/**
 * Universal package installer
 *
 * Handles downloading and installing software from various package formats:
 * .dmg, .pkg, .zip, .tar.gz, .deb, .rpm, .AppImage, .exe, .msi, etc.
 *
 * Flow: download → detect format → route to handler → install → cleanup
 */
export namespace Package {
  export interface DownloadResult {
    path: string
    filename: string
    format: Format
  }

  export interface InstallResult {
    ok: boolean
    message: string
    installed_path?: string
  }

  export type Format =
    | "dmg"
    | "pkg"
    | "zip"
    | "tar.gz"
    | "tar.bz2"
    | "tar.xz"
    | "deb"
    | "rpm"
    | "appimage"
    | "exe"
    | "msi"
    | "snap"
    | "flatpak"
    | "binary"
    | "unknown"

  export interface InstallOptions {
    /** Target install directory (default: platform-appropriate) */
    target?: string
    /** App name (used for logging and .app matching) */
    name?: string
    /** Run with sudo if needed */
    sudo?: boolean
    /** Keep downloaded file after install */
    keep?: boolean
    /** Silent/unattended install (skip interactive prompts) */
    silent?: boolean
  }

  // ─────────────────────────────────────
  //  Format Detection
  // ─────────────────────────────────────

  export function detect(filename: string): Format {
    const lower = filename.toLowerCase()
    if (lower.endsWith(".dmg")) return "dmg"
    if (lower.endsWith(".pkg") || lower.endsWith(".mpkg")) return "pkg"
    if (lower.endsWith(".zip")) return "zip"
    if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz"
    if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar.bz2"
    if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) return "tar.xz"
    if (lower.endsWith(".deb")) return "deb"
    if (lower.endsWith(".rpm")) return "rpm"
    if (lower.endsWith(".appimage")) return "appimage"
    if (lower.endsWith(".exe")) return "exe"
    if (lower.endsWith(".msi")) return "msi"
    if (lower.endsWith(".snap")) return "snap"
    if (lower.endsWith(".flatpak") || lower.endsWith(".flatpakref")) return "flatpak"
    return "unknown"
  }

  // ─────────────────────────────────────
  //  Download
  // ─────────────────────────────────────

  const DOWNLOAD_DIR = path.join(process.env.HOME || "~", "Downloads", ".envready-tmp")

  export async function download(url: string, filename?: string): Promise<DownloadResult> {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

    let fname = filename || url.split("/").pop() || "download"

    // If filename has no recognizable extension, probe via HTTP HEAD to get real filename
    if (detect(fname) === "unknown") {
      Log.file(`[Package:download] unknown extension for "${fname}", probing with HEAD...`)
      try {
        // Get all response headers (following redirects)
        const rawHeaders = await Shell.exec(`curl -sIL "${url}"`, { timeout: 15_000 })

        // Strategy 1: Content-Disposition filename
        const dispMatch = rawHeaders.match(/content-disposition:.*filename[*]?=["']?([^"'\s;\n]+)/i)
        if (dispMatch) {
          const decoded = decodeURIComponent(dispMatch[1]!)
          if (detect(decoded) !== "unknown") {
            fname = decoded.replace(/\s+/g, "-")
            Log.file(`[Package:download] resolved from Content-Disposition: ${fname}`)
          }
        }

        // Strategy 2: effective URL after redirects
        if (detect(fname) === "unknown") {
          const locationMatches = rawHeaders.match(/location:\s*(\S+)/gi)
          const finalUrl = locationMatches ? locationMatches[locationMatches.length - 1]!.replace(/location:\s*/i, "").trim() : ""
          const urlFilename = finalUrl.split("/").pop()?.split("?")[0] || ""
          if (detect(urlFilename) !== "unknown") {
            fname = urlFilename
            Log.file(`[Package:download] resolved from redirect URL: ${fname}`)
          }
        }

        // Strategy 3: Content-Type
        if (detect(fname) === "unknown") {
          const ctMatch = rawHeaders.match(/content-type:\s*([^\s;\n]+)/i)
          const contentType = ctMatch ? ctMatch[1]! : ""
          const ext = contentTypeToExt(contentType)
          if (ext) {
            fname = `${fname}${ext}`
            Log.file(`[Package:download] resolved from Content-Type (${contentType}): ${ext}`)
          }
        }
      } catch {
        Log.file("[Package:download] HEAD probe failed, proceeding with original filename")
      }
    }

    const dest = path.join(DOWNLOAD_DIR, fname)
    Log.stage("Package:download", `${url} → ${dest}`)

    // Use curl with progress bar, follow redirects
    await Shell.exec(
      `curl -fSL --progress-bar -o "${dest}" "${url}"`,
      { timeout: 600_000 }, // 10 min timeout for large files
    )

    if (!fs.existsSync(dest)) {
      throw new Error(`Download failed: file not found at ${dest}`)
    }

    // If still unknown, try to detect from file magic bytes
    let format = detect(fname)
    if (format === "unknown") {
      format = await detectFromMagic(dest)
    }

    Log.file(`[Package:download] ok format=${format} size=${fs.statSync(dest).size} path=${dest}`)
    return { path: dest, filename: fname, format }
  }

  function contentTypeToExt(ct: string): string | null {
    const type = ct.split(";")[0]?.trim().toLowerCase() || ""
    const map: Record<string, string> = {
      "application/x-apple-diskimage": ".dmg",
      "application/x-diskcopy": ".dmg",
      "application/vnd.apple.installer+xml": ".pkg",
      "application/zip": ".zip",
      "application/x-zip-compressed": ".zip",
      "application/gzip": ".tar.gz",
      "application/x-gzip": ".tar.gz",
      "application/x-tar": ".tar.gz",
      "application/x-bzip2": ".tar.bz2",
      "application/x-xz": ".tar.xz",
      "application/vnd.debian.binary-package": ".deb",
      "application/x-rpm": ".rpm",
      "application/x-msi": ".msi",
      "application/x-msdos-program": ".exe",
      "application/x-executable": ".AppImage",
      "application/octet-stream": "", // ambiguous, skip
    }
    return map[type] || null
  }

  async function detectFromMagic(filepath: string): Promise<Format> {
    try {
      const result = await Shell.exec(`file --brief --mime-type "${filepath}"`, { timeout: 5000 })
      const mime = result.trim()
      Log.file(`[Package:magic] ${filepath} → ${mime}`)

      if (mime.includes("apple-diskimage") || mime.includes("x-diskcopy")) return "dmg"
      if (mime.includes("zip")) return "zip"
      if (mime.includes("gzip") || mime.includes("x-tar")) return "tar.gz"
      if (mime.includes("bzip2")) return "tar.bz2"
      if (mime.includes("x-xz")) return "tar.xz"
      if (mime.includes("debian")) return "deb"
      if (mime.includes("rpm")) return "rpm"
      if (mime.includes("x-msi")) return "msi"
      if (mime.includes("x-executable") || mime.includes("x-pie-executable")) return "binary"
    } catch {}
    return "unknown"
  }

  // ─────────────────────────────────────
  //  Install (router)
  // ─────────────────────────────────────

  export async function install(file: DownloadResult, opts?: InstallOptions): Promise<InstallResult> {
    const format = file.format === "unknown" ? detect(file.filename) : file.format
    Log.stage("Package:install", `format=${format} file=${file.filename}`)

    const o = opts || {}

    const result = await ((): Promise<InstallResult> => {
      switch (format) {
        case "dmg": return installDmg(file.path, o)
        case "pkg": return installPkg(file.path, o)
        case "zip": return installZip(file.path, o)
        case "tar.gz":
        case "tar.bz2":
        case "tar.xz": return installTar(file.path, format, o)
        case "deb": return installDeb(file.path, o)
        case "rpm": return installRpm(file.path, o)
        case "appimage": return installAppImage(file.path, o)
        case "exe": return installExe(file.path, o)
        case "msi": return installMsi(file.path, o)
        case "snap": return installSnap(file.path, o)
        case "flatpak": return installFlatpak(file.path, o)
        case "binary": return installBinary(file.path, o)
        default: return Promise.resolve({ ok: false, message: `Unsupported format: ${format}` })
      }
    })()

    // Cleanup
    if (!o.keep && result.ok) {
      cleanup(file.path)
    }

    Log.file(`[Package:install] ${result.ok ? "ok" : "fail"} ${result.message}`)
    return result
  }

  /** Download + install in one step */
  export async function fromUrl(url: string, opts?: InstallOptions & { filename?: string }): Promise<InstallResult> {
    const file = await download(url, opts?.filename)
    return install(file, opts)
  }

  // ─────────────────────────────────────
  //  macOS: .dmg
  // ─────────────────────────────────────

  async function installDmg(filepath: string, opts: InstallOptions): Promise<InstallResult> {
    const mountPoint = `/tmp/envready-dmg-${Date.now()}`

    try {
      // Mount the DMG (no UI, no auto-open)
      Log.file(`[dmg] mounting ${filepath} → ${mountPoint}`)
      await Shell.exec(`hdiutil attach "${filepath}" -mountpoint "${mountPoint}" -nobrowse -noverify -noautoopen`, { timeout: 60_000 })

      // Look for content inside the mounted volume
      const contents = fs.readdirSync(mountPoint)
      Log.file(`[dmg] contents: ${contents.join(", ")}`)

      // Strategy 1: .app → copy to /Applications
      const app = contents.find((f) => f.endsWith(".app"))
      if (app) {
        const target = opts.target || "/Applications"
        const appPath = path.join(target, app)

        // Remove existing if present
        if (fs.existsSync(appPath)) {
          Log.file(`[dmg] removing existing ${appPath}`)
          await Shell.exec(`rm -rf "${appPath}"`)
        }

        await Shell.exec(`cp -R "${path.join(mountPoint, app)}" "${target}/"`)
        Log.file(`[dmg] installed ${app} → ${target}`)

        return { ok: true, message: `已安装 ${app} → ${target}`, installed_path: appPath }
      }

      // Strategy 2: .pkg inside DMG → delegate to pkg installer
      const pkg = contents.find((f) => f.endsWith(".pkg") || f.endsWith(".mpkg"))
      if (pkg) {
        const pkgPath = path.join(mountPoint, pkg)
        return installPkg(pkgPath, opts)
      }

      // Strategy 3: single binary
      const binaries = contents.filter((f) => {
        const full = path.join(mountPoint, f)
        try {
          return fs.statSync(full).isFile() && !f.startsWith(".")
        } catch {
          return false
        }
      })

      if (binaries.length === 1) {
        return installBinary(path.join(mountPoint, binaries[0]!), opts)
      }

      return { ok: false, message: `DMG 中未找到可安装的 .app/.pkg 文件，内容: ${contents.join(", ")}` }
    } finally {
      // Always unmount
      try {
        await Shell.exec(`hdiutil detach "${mountPoint}" -force 2>/dev/null || true`, { timeout: 15_000 })
      } catch {}
    }
  }

  // ─────────────────────────────────────
  //  macOS: .pkg / .mpkg
  // ─────────────────────────────────────

  async function installPkg(filepath: string, opts: InstallOptions): Promise<InstallResult> {
    const target = opts.target || "/"
    const sudo = opts.sudo !== false ? "sudo " : ""

    Log.file(`[pkg] installing ${filepath} → ${target}`)
    await Shell.exec(`${sudo}installer -pkg "${filepath}" -target "${target}"`, { timeout: 300_000 })

    return { ok: true, message: `已安装 ${path.basename(filepath)}` }
  }

  // ─────────────────────────────────────
  //  .zip
  // ─────────────────────────────────────

  async function installZip(filepath: string, opts: InstallOptions): Promise<InstallResult> {
    const tmpDir = `/tmp/envready-zip-${Date.now()}`
    fs.mkdirSync(tmpDir, { recursive: true })

    try {
      await Shell.exec(`unzip -o -q "${filepath}" -d "${tmpDir}"`, { timeout: 120_000 })
      const contents = fs.readdirSync(tmpDir)
      Log.file(`[zip] contents: ${contents.join(", ")}`)

      // macOS: .app in zip → /Applications
      const app = contents.find((f) => f.endsWith(".app"))
      if (app) {
        const target = opts.target || "/Applications"
        const appPath = path.join(target, app)
        if (fs.existsSync(appPath)) {
          await Shell.exec(`rm -rf "${appPath}"`)
        }
        await Shell.exec(`cp -R "${path.join(tmpDir, app)}" "${target}/"`)
        return { ok: true, message: `已安装 ${app} → ${target}`, installed_path: appPath }
      }

      // Single binary in zip
      const files = contents.filter((f) => {
        const full = path.join(tmpDir, f)
        try {
          return fs.statSync(full).isFile() && !f.startsWith(".")
        } catch {
          return false
        }
      })

      if (files.length === 1) {
        return installBinary(path.join(tmpDir, files[0]!), opts)
      }

      // Multiple files → extract to target
      const target = opts.target || "/usr/local"
      await Shell.exec(`cp -R "${tmpDir}/"* "${target}/"`)
      return { ok: true, message: `已解压到 ${target}`, installed_path: target }
    } finally {
      await Shell.exec(`rm -rf "${tmpDir}" 2>/dev/null || true`)
    }
  }

  // ─────────────────────────────────────
  //  .tar.gz / .tar.bz2 / .tar.xz
  // ─────────────────────────────────────

  async function installTar(filepath: string, format: Format, opts: InstallOptions): Promise<InstallResult> {
    const target = opts.target || "/usr/local"
    const sudo = opts.sudo !== false && target.startsWith("/usr") ? "sudo " : ""

    const flag = format === "tar.bz2" ? "j" : format === "tar.xz" ? "J" : "z"

    Log.file(`[tar] extracting ${filepath} → ${target}`)
    await Shell.exec(`${sudo}tar -x${flag}f "${filepath}" -C "${target}"`, { timeout: 120_000 })

    return { ok: true, message: `已解压到 ${target}`, installed_path: target }
  }

  // ─────────────────────────────────────
  //  Linux: .deb
  // ─────────────────────────────────────

  async function installDeb(filepath: string, _opts: InstallOptions): Promise<InstallResult> {
    Log.file(`[deb] installing ${filepath}`)
    // dpkg install + fix dependencies
    await Shell.exec(`sudo dpkg -i "${filepath}"`, { timeout: 120_000 })
    await Shell.exec(`sudo apt-get install -f -y`, { timeout: 120_000 })

    return { ok: true, message: `已安装 ${path.basename(filepath)}` }
  }

  // ─────────────────────────────────────
  //  Linux: .rpm
  // ─────────────────────────────────────

  async function installRpm(filepath: string, _opts: InstallOptions): Promise<InstallResult> {
    Log.file(`[rpm] installing ${filepath}`)

    // Prefer dnf, fallback to rpm
    const hasDnf = await Shell.has("dnf")
    if (hasDnf) {
      await Shell.exec(`sudo dnf install -y "${filepath}"`, { timeout: 120_000 })
    } else {
      await Shell.exec(`sudo rpm -i "${filepath}"`, { timeout: 120_000 })
    }

    return { ok: true, message: `已安装 ${path.basename(filepath)}` }
  }

  // ─────────────────────────────────────
  //  Linux: .AppImage
  // ─────────────────────────────────────

  async function installAppImage(filepath: string, opts: InstallOptions): Promise<InstallResult> {
    const target = opts.target || path.join(process.env.HOME || "~", ".local", "bin")
    fs.mkdirSync(target, { recursive: true })

    const name = opts.name || path.basename(filepath, ".AppImage").toLowerCase()
    const dest = path.join(target, name)

    await Shell.exec(`cp "${filepath}" "${dest}"`)
    await Shell.exec(`chmod +x "${dest}"`)

    Log.file(`[appimage] installed ${name} → ${dest}`)
    return { ok: true, message: `已安装 ${name} → ${dest}`, installed_path: dest }
  }

  // ─────────────────────────────────────
  //  Windows: .exe (silent install)
  // ─────────────────────────────────────

  async function installExe(filepath: string, opts: InstallOptions): Promise<InstallResult> {
    const silent = opts.silent !== false ? " /S /SILENT /VERYSILENT /NORESTART" : ""
    Log.file(`[exe] installing ${filepath}${silent}`)
    await Shell.exec(`"${filepath}"${silent}`, { timeout: 600_000 })

    return { ok: true, message: `已安装 ${path.basename(filepath)}` }
  }

  // ─────────────────────────────────────
  //  Windows: .msi (silent install)
  // ─────────────────────────────────────

  async function installMsi(filepath: string, opts: InstallOptions): Promise<InstallResult> {
    const silent = opts.silent !== false ? " /qn /norestart" : ""
    Log.file(`[msi] installing ${filepath}${silent}`)
    await Shell.exec(`msiexec /i "${filepath}"${silent}`, { timeout: 600_000 })

    return { ok: true, message: `已安装 ${path.basename(filepath)}` }
  }

  // ─────────────────────────────────────
  //  Linux: .snap
  // ─────────────────────────────────────

  async function installSnap(filepath: string, _opts: InstallOptions): Promise<InstallResult> {
    Log.file(`[snap] installing ${filepath}`)
    await Shell.exec(`sudo snap install "${filepath}" --dangerous`, { timeout: 120_000 })
    return { ok: true, message: `已安装 ${path.basename(filepath)}` }
  }

  // ─────────────────────────────────────
  //  Linux: .flatpak
  // ─────────────────────────────────────

  async function installFlatpak(filepath: string, _opts: InstallOptions): Promise<InstallResult> {
    Log.file(`[flatpak] installing ${filepath}`)
    await Shell.exec(`flatpak install -y "${filepath}"`, { timeout: 120_000 })
    return { ok: true, message: `已安装 ${path.basename(filepath)}` }
  }

  // ─────────────────────────────────────
  //  Generic binary
  // ─────────────────────────────────────

  async function installBinary(filepath: string, opts: InstallOptions): Promise<InstallResult> {
    const target = opts.target || "/usr/local/bin"
    const name = opts.name || path.basename(filepath)
    const dest = path.join(target, name)
    const sudo = target.startsWith("/usr") ? "sudo " : ""

    Log.file(`[binary] installing ${filepath} → ${dest}`)
    await Shell.exec(`${sudo}cp "${filepath}" "${dest}"`)
    await Shell.exec(`${sudo}chmod +x "${dest}"`)

    return { ok: true, message: `已安装 ${name} → ${dest}`, installed_path: dest }
  }

  // ─────────────────────────────────────
  //  Cleanup
  // ─────────────────────────────────────

  function cleanup(filepath: string) {
    try {
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath)
      // Clean up empty tmp dir
      if (fs.existsSync(DOWNLOAD_DIR) && fs.readdirSync(DOWNLOAD_DIR).length === 0) {
        fs.rmdirSync(DOWNLOAD_DIR)
      }
    } catch {}
  }

  /** Clean all temporary download files */
  export function cleanAll() {
    try {
      if (fs.existsSync(DOWNLOAD_DIR)) {
        fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true })
      }
    } catch {}
  }

  // ─────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────

  /** Get recommended format for current platform */
  export function recommended(): Format[] {
    switch (process.platform) {
      case "darwin": return ["dmg", "pkg", "zip", "tar.gz"]
      case "linux": return ["deb", "rpm", "appimage", "snap", "tar.gz"]
      case "win32": return ["msi", "exe", "zip"]
      default: return ["tar.gz", "zip", "binary"]
    }
  }

  /** Check if a format is supported on current platform */
  export function supported(format: Format): boolean {
    switch (format) {
      case "dmg":
      case "pkg": return process.platform === "darwin"
      case "deb": return process.platform === "linux"
      case "rpm": return process.platform === "linux"
      case "appimage": return process.platform === "linux"
      case "snap": return process.platform === "linux"
      case "flatpak": return process.platform === "linux"
      case "exe":
      case "msi": return process.platform === "win32"
      case "zip":
      case "tar.gz":
      case "tar.bz2":
      case "tar.xz":
      case "binary": return true
      default: return false
    }
  }
}
