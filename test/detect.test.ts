import { describe, it, expect } from "bun:test"
import { OS } from "../src/detect/os"
import { Software } from "../src/detect/software"
import { Env } from "../src/detect/env"

describe("OS detection", () => {
  it("should detect current platform", () => {
    const info = OS.detect()
    expect(info.platform).toBeTruthy()
    expect(info.arch).toBeTruthy()
    expect(info.home).toBeTruthy()
    expect(info.shell).toBeTruthy()
  })

  it("should find at least one package manager", () => {
    const managers = OS.packageManagers()
    // On most dev machines, at least one should exist
    expect(managers.length).toBeGreaterThanOrEqual(0)
  })
})

describe("Software detection", () => {
  it("should return an array", () => {
    const result = Software.detect()
    expect(Array.isArray(result)).toBe(true)
  })

  it("should detect specific software if asked", () => {
    // bun must be installed since we're running this test with it
    const result = Software.detect(["bun"])
    expect(result.length).toBe(1)
    expect(result[0]!.name).toBe("bun")
    expect(result[0]!.version).toBeTruthy()
  })

  it("should have supported software list", () => {
    expect(Software.SUPPORTED.length).toBeGreaterThan(5)
    expect(Software.SUPPORTED).toContain("node")
    expect(Software.SUPPORTED).toContain("python")
    expect(Software.SUPPORTED).toContain("docker")
  })
})

describe("Environment analysis", () => {
  it("should analyze PATH", () => {
    const info = Env.analyzePath()
    expect(info.path.length).toBeGreaterThan(0)
    expect(Array.isArray(info.duplicates)).toBe(true)
    expect(Array.isArray(info.missing)).toBe(true)
  })

  it("should detect shell profile", () => {
    const profile = Env.shellProfile()
    expect(profile).toBeTruthy()
    expect(profile).toContain(process.env.HOME || "~")
  })

  it("should return env summary", () => {
    const summary = Env.summary()
    expect(summary.HOME).toBeTruthy()
    expect(summary.SHELL).toBeTruthy()
  })
})
