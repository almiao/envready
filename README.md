# envready

AI-powered software environment setup tool.

## Quick Start

```bash
# Install dependencies
bun install

# Detect your environment
bun run src/index.ts detect

# List available software
bun run src/index.ts list

# Install software (dry-run)
bun run src/index.ts install node python --dry-run

# Install software
bun run src/index.ts install rust

# Apply a config file
bun run src/index.ts apply envready.example.yaml

# AI chat (requires OPENAI_API_KEY)
export OPENAI_API_KEY=sk-...
bun run src/index.ts chat "帮我配置 Python 开发环境"
```

## Commands

| Command | Description |
|---------|-------------|
| `detect` | Detect current system environment |
| `install <software..>` | Install one or more software tools |
| `list` | List available software and status |
| `apply [file]` | Apply an envready config file |
| `chat [message..]` | AI-assisted troubleshooting |

## Supported Software

- **node** — Node.js (via fnm/nvm)
- **python** — Python (via pyenv)
- **go** — Go
- **rust** — Rust (via rustup)
- **docker** — Docker

## Configuration

Create `envready.yaml` in your project:

```yaml
name: "My Dev Environment"
tools:
  - name: node
    version: "20"
  - name: python
    version: "3.12"
  - name: docker
```

See `envready.example.yaml` for a full example.

## Development

```bash
bun test          # Run tests
bun run typecheck # Type check
```

## Design

See [DESIGN.md](./DESIGN.md) for the full product design document.
