# envready

> AI-powered software environment setup tool — 从"装环境"到"一句话搞定"

## Quick Start

```bash
# Install dependencies
bun install

# Set AI key (required for intelligent features)
export OPENAI_API_KEY=sk-...

# Natural language installation
bun run src/index.ts install "前端开发环境"

# Or specific software
bun run src/index.ts install node python docker

# Detect your environment
bun run src/index.ts detect

# List available software
bun run src/index.ts list
```

## Key Features

### 🤖 AI-Driven Installation

**Natural language → Automated setup**

```bash
# Tell AI what you need in plain language
envready install "机器学习工具链"
# → AI recommends: Python 3.12, PyTorch, Jupyter, CUDA
# → User confirms → Automated installation

envready install "博客写作环境"
# → AI suggests: Hugo/Hexo, Git, VS Code, Node.js
```

### 🎯 Smart Recommendations

- **Intent understanding**: "前端开发" → node, pnpm, git
- **De-duplication**: Checks what's installed, recommends only what's needed
- **Version conflicts**: Detects and suggests pyenv/nvm/rustup when needed

### 🔧 Hybrid Installation Model

| Software Type | Strategy |
|--------------|----------|
| **Common tools** (node, python, go, rust, docker) | Local installers (fast, stable, offline-capable) |
| **Long-tail tools** (ripgrep, fd, bat, nginx, redis) | AI-generated plans (zero maintenance) |
| **Enterprise tools** | AI generates from docs/URLs |

Use `--skipAi` to force local installers only (for CI/CD).

### 📦 Configuration Files

```yaml
# envready.yaml
name: "Full-Stack Dev Environment"
tools:
  - name: node
    version: "20"
  - name: python
    version: "3.12"
  - name: docker
```

```bash
envready apply  # One command → Complete environment
```

## Commands

| Command | Description |
|---------|-------------|
| `install <input..>` | Install software (names or natural language) |
| `detect` | Detect current system environment |
| `list` | List available software and status |
| `apply [file]` | Apply an envready config file |
| `chat [message..]` | AI-assisted troubleshooting |

## Supported Software

**Local installers (fast, stable)**:
- node (via fnm/nvm)
- python (via pyenv)
- go
- rust (via rustup)
- docker

**AI-generated (unlimited)**:
- Any software with documentation
- Package manager supported tools
- Custom enterprise tools

## Examples

### Example 1: Fresh Machine Setup

```bash
envready install "全栈开发环境，包括 Node、Python、Docker"
# AI analyzes → Recommends tools → User confirms → Installs
```

### Example 2: Onboarding New Team Member

```bash
# Team repo contains envready.yaml
git clone team-repo
cd team-repo
envready apply
# → Entire team environment replicated
```

### Example 3: Install Unsupported Software

```bash
envready install ripgrep
# Local installer not found
# → AI generates: "brew install ripgrep" (macOS) or apt equivalent
# → User confirms → Executes
```

## Development

```bash
bun test          # Run tests
bun run typecheck # Type check
```

## Architecture

```
User Input
    ↓
AI Analyzes Intent → Recommends Tools
    ↓
For each tool:
    ├─ Local installer exists? → Use it (fast)
    └─ No → AI generates install plan → Execute
    ↓
Verify installation
    ↓
Configure environment (JAVA_HOME, PATH, etc.)
```

## Design Philosophy

1. **AI-first, not AI-only** — Local installers for common tools ensure speed and offline capability
2. **Model config is required** — User intent, de-duplication, troubleshooting all depend on AI
3. **Transparent execution** — Users see and confirm commands before execution
4. **Long-tail coverage** — AI handles any software, not just what we've pre-coded

## Documentation

- [DESIGN.md](./DESIGN.md) — Full product design (architecture, roadmap, use cases)
- [envready.example.yaml](./envready.example.yaml) — Config file example

---

**Status**: MVP (Phase 0) — CLI functional, AI-driven installation, 5 local installers, config file support

**Next**: Service management (`envready serve`), environment auto-config (`envready configure`), TUI interface
