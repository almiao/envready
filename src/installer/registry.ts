import { Installer } from "./installer"

const registry = new Map<string, Installer.Info>()

export namespace Registry {
  export function register(installer: Installer.Info) {
    registry.set(installer.name, installer)
  }

  export function get(name: string): Installer.Info | undefined {
    return registry.get(name)
  }

  export function all(): Installer.Info[] {
    return Array.from(registry.values())
  }

  export function names(): string[] {
    return Array.from(registry.keys())
  }

  export function search(query: string): Installer.Info[] {
    const lower = query.toLowerCase()
    return all().filter(
      (i) =>
        i.name.toLowerCase().includes(lower) ||
        i.description.toLowerCase().includes(lower) ||
        i.tags.some((t) => t.toLowerCase().includes(lower)),
    )
  }
}

// Auto-register all built-in installers
async function loadBuiltins() {
  const modules = [
    import("./installers/node"),
    import("./installers/python"),
    import("./installers/go"),
    import("./installers/rust"),
    import("./installers/docker"),
  ]
  const loaded = await Promise.all(modules)
  for (const mod of loaded) {
    if (mod.default) Registry.register(mod.default)
  }
}

export const ready = loadBuiltins()
