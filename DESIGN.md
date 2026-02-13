# envready 产品设计文档

> AI 驱动的软件环境一键配置工具

## 1. 产品愿景

**一句话**：让"装环境"这件事从"令人头疼的折腾"变成"一键搞定的愉快体验"。

**核心价值**：
- 用 AI 理解用户意图，智能推荐和安装、配置软件
- 遇到问题时 AI 自动诊断和修复，而不是让用户去 Google
- 一个配置文件描述整个开发环境，新机器 / 新同事一键复现

## 2. 目标用户

### 2.1 程序员用户
- **画像**：需要频繁搭建/切换开发环境、安装各种特定软件的开发者
- **痛点**：新机器配置耗时、多版本管理混乱、环境问题排查困难
- **交互偏好**：CLI / TUI，高信息密度，可脚本化

### 2.2 普通用户
- **画像**：需要安装开发工但不熟悉命令行的学生/初学者
- **痛点**：看不懂安装教程、配环境变量困惑、出错不知如何解决
- **交互偏好**：Web UI / Desktop App，引导式操作，简洁明了

## 3. 核心功能

### 3.1 环境检测 (detect)

```
envready detect
```

自动扫描当前系统，输出：
- 操作系统 / 架构信息
- 已安装的开发工具及版本
- 包管理器
- 环境变量状态
- 潜在问题（PATH 重复、版本冲突等）

**价值**：让用户对自己的环境有全局认知，AI 排障的信息基础。

### 3.2 软件安装 (install)

```
envready install node python docker
envready install "搭建一个 React 开发环境"
envready install node --ver 20
envready install --skipAi redis  # 仅使用本地安装器
```

**核心改进：模型驱动 + 本地安装器混合模式**

#### 安装流程（两阶段）

**阶段 1：需求理解与方案推荐（AI）**

用户输入可以是：
- 明确软件名：`node python`（直接解析）
- 自然语言意图：`"前端开发环境"` / `"机器学习工具链"` / `"搭建博客需要什么"`

模型执行：
1. 理解用户意图，推荐工具列表（含版本、推荐理由）
2. 检查已安装软件，去重或提示升级
3. 输出推荐方案供用户确认

示例输出：
```
🤖 推荐安装方案：
  • node@20 — React 开发必需的 JavaScript 运行时
  • pnpm — 比 npm 更快的包管理器
  • git — 版本管理工具
```

**阶段 2：执行安装（本地安装器 or AI 生成）**

对推荐列表中的每个工具：

1. **优先查询本地安装器** — 若 `Registry.get(name)` 存在（如 `node.ts`）：
   - 使用现有 `Installer.define()` 逻辑
   - 已验证、稳定、快速

2. **否则，AI 动态生成安装方案**：
   - 输入：软件名、版本、当前 OS/架构、包管理器
   - 输出 JSON 方案：
     ```json
     {
       "description": "软件简介",
       "downloadSource": "官网 / brew / apt",
       "commands": ["brew install redis", "brew services start redis"],
       "verifyCommand": "redis-cli --version",
       "envVars": {"REDIS_PORT": "6379"}
     }
     ```
   - 展示给用户确认后执行
   - 失败时 AI 分析日志 → 修复建议 → 可选重试

3. **安装后验证** — 执行 `verifyCommand` / `installer.verify()`

4. **环境配置提示** — 若需设置环境变量，提示运行 `envready configure`

#### 关键设计原则

- **幂等性**：重复执行不会破坏已有配置
- **可逆性**：每步操作都有回滚方案
- **透明性**：用户能看到正在执行什么（命令可见、可确认）
- **灵活性**：本地安装器保证常用软件的稳定性，AI 覆盖长尾需求
- **回退机制**：`--no-ai` 强制使用本地安装器（CI/CD 等无网络场景）

#### 价值

- **智能推荐** — "我要做机器学习" → 自动推荐 Python + PyTorch + CUDA + Jupyter
- **长尾覆盖** — 即使没写过 `nginx.ts`、`redis.ts`，AI 也能生成可靠安装方案
- **安装即文档** — AI 生成的安装方案就是"如何安装这个软件"的文档

### 3.3 配置文件 (apply)

```yaml
# envready.yaml
name: "全栈开发环境"
tools:
  - name: node
    version: "20"
    config:
      manager: fnm
  - name: python
    version: "3.12"
  - name: docker
hooks:
  post_install:
    - "pnpm install"
```

```
envready apply                    # 自动找到 envready.yaml
envready apply ./my-config.yaml   # 指定文件
```

**价值**：团队环境一致性，新人入职一键搭建。

### 3.4 AI 对话 (chat)

```
envready chat
envready chat "帮我装一个 Go 开发环境"
```

AI 具备的能力：
- 理解自然语言需求（"我要做机器学习" → 推荐 Python + PyTorch + CUDA...）
- 自动获取系统上下文（OS、已装软件、环境变量）
- 多轮对话解决复杂问题
- 生成并执行安装命令（用户确认后）

### 3.5 软件列表 (list)

```
envready list                # 所有可安装软件
envready list --installed    # 已安装的
envready list -s python      # 搜索
```

### 3.6 模型配置 (model) — 核心前置能力

**模型配置是必须的**，而非可选增强。以下能力都依赖模型：

- **用户需求理解** — 自然语言（"我要做前端开发"）→ 解析为待安装工具列表、版本偏好
- **已安装软件排重与决策** — 检测到已安装后的行为：跳过 / 升级 / 多版本并存，需模型参与推荐
- **安装失败诊断** — 日志分析、原因归纳、修复建议与可选自动修复
- **环境变量与配置生成** — 如 Java 的 `JAVA_HOME`、Go 的 `GOROOT`/`GOPATH` 等，由模型结合当前环境生成并写入

因此需要在产品中**显式提供模型配置**（Provider、API Key、模型名等），并在首次使用或缺少配置时引导用户完成设置。配置方式包括：

- 全局配置：`~/.config/envready/config.yaml` 中的 `model` / `provider` 段
- 环境变量：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等
- 项目级覆盖：`envready.yaml` 中的 `model`（可选，用于团队统一模型）

详见下文 [4.2 核心模块 - 模型配置](#模型配置-model-config--必选)。

### 3.7 服务启动与环境配置 (serve / configure)

安装完成后，很多工具还需要**写入环境变量**或**启动常驻服务**，才能被正常使用。该能力与「安装」并列，是「环境就绪」的最后一环。

**环境变量配置**（写入 shell profile 或系统环境）：

- **Java** — `JAVA_HOME`、`PATH` 增加 `$JAVA_HOME/bin`
- **Go** — `GOROOT`、`GOPATH`、`PATH` 增加 `$GOPATH/bin`
- **Python (pyenv)** — `eval "$(pyenv init -)"` 等写入 `~/.zshrc` / `~/.bashrc`
- **Rust** — `source $HOME/.cargo/env`
- **Node (fnm/nvm)** — 对应 init 脚本写入 profile

**服务类软件的启动与配置**（安装后自动或按需启动）：

- **Redis** — `brew services start redis` 或 systemd 等效
- **PostgreSQL / MySQL** — 安装后创建数据目录、初始库、并启动服务
- **Docker** — 确保 Docker daemon 已启动（macOS 下 Docker Desktop）

**交互形态**：

```
envready configure              # 根据当前已安装软件，自动生成并写入环境变量
envready configure --dry-run    # 仅打印将要写入的内容，不实际写文件
envready serve start redis      # 启动 Redis 服务
envready serve stop redis       # 停止
envready serve status           # 查看所有已配置服务的状态
```

在 `envready.yaml` 中可声明「安装后需要执行的配置与服务」：

```yaml
tools:
  - name: java
    version: "17"
    env:                          # 安装后写入的环境变量
      JAVA_HOME: "/path/to/jdk17"  # 可由安装器输出或模板填充
  - name: redis
    service: true                  # 安装后注册为可管理服务
    start_after_install: false     # 是否在 apply 结束时自动 start
```

**价值**：用户执行 `envready apply` 后，不仅「装好了」，而且「开箱即用」—— 环境变量已配好、需要跑的服务已启动，无需再手动改 profile 或查文档。

## 4. 架构设计

### 4.1 整体架构

```
┌─────────────────────────────────────────────────────┐
│                    交互层 (Interface)                │
│  CLI ← yargs   │  TUI ← ink/opentui  │  Web ← API  │
└────────┬────────┴──────────┬──────────┴──────┬──────┘
         │                   │                 │
         ▼                   ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                    核心层 (Core)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Installer│ │ Detector │ │ AI Agent │ │ Config │ │
│  │ Registry │ │  Engine  │ │          │ │ Loader │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ │
└────────┬────────┴──────────┬──────────┴──────┬──────┘
         │                   │                 │
         ▼                   ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                    执行层 (Executor)                 │
│  Shell Executor  │  Package Manager  │  File System  │
└─────────────────────────────────────────────────────┘
```

### 4.2 核心模块

#### Installer (安装器) — 本地知识库

借鉴 OpenCode 的 Tool.define() 模式，**作为常用软件的优先方案**：

```typescript
Installer.define({
  name: "node",
  description: "Node.js via fnm",
  parameters: z.object({ version: z.string(), manager: z.enum(["fnm","nvm"]) }),
  detect(ctx)   → DetectResult,     // 检测当前状态
  install(args, ctx) → InstallResult, // 执行安装
  verify(ctx)   → DetectResult,     // 验证结果
  uninstall(ctx) → Result,          // 卸载（可选）
})
```

每个安装器是独立模块，注册到 Registry。新增软件支持 = 新增一个文件。

**本地安装器 vs AI 生成方案的取舍**：

| 场景 | 使用本地安装器 | 使用 AI 生成 |
|------|---------------|-------------|
| 常用软件（node/python/go/rust/docker） | ✅ 快速、稳定、免 API 调用 | ❌ |
| 小众软件（ripgrep/fd/bat） | ❌ 维护成本高 | ✅ 动态生成，零维护 |
| 企业内部工具 | ❌ | ✅ AI 可根据文档/URL 生成 |
| 离线/CI 场景 | ✅ `--no-ai` 强制本地 | ❌ |

**策略**：维护 20-30 个最常用软件的本地安装器，其余全部由 AI 覆盖。

#### Registry (注册表)

```typescript
Registry.register(installer)  // 注册
Registry.get("node")          // 获取
Registry.search("python")     // 搜索
Registry.all()                // 列表
```

#### Detector (检测引擎)

三个维度：
- `OS` — 操作系统、架构、包管理器
- `Software` — 已安装软件版本和路径
- `Env` — 环境变量、PATH 分析、shell profile

#### 模型配置 (Model Config) — 必选

模型配置是核心能力的前置条件，不是「有则增强」的附加项。所有依赖语义理解与决策的流程都需要模型：

| 能力 | 依赖模型的原因 |
|------|----------------|
| 用户需求理解 | 自然语言 → 工具列表、版本、安装顺序 |
| 已安装排重与决策 | 检测到已安装后：跳过 / 升级 / 多版本并存，需模型推荐 |
| 安装失败诊断 | 日志 → 原因归纳、修复建议、可选自动修复 |
| 环境变量生成 | 如 JAVA_HOME、GOROOT 等，根据安装路径与 OS 生成并写入 |

**配置层级**：

- **全局**：`~/.config/envready/config.yaml` 中 `model` / `provider`
- **环境变量**：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`ENVREADY_MODEL` 等
- **项目**：`envready.yaml` 中 `model`（可选，团队统一）

**配置项示例**（Schema 中需包含）：

```yaml
model:
  provider: openai   # openai | anthropic | ollama | ...
  model: gpt-4o-mini
  apiKey: ${OPENAI_API_KEY}  # 或直接写，不推荐提交到仓库
  baseURL: null      # 兼容兼容 OpenAI API 的代理或本地服务
```

首次运行且未配置时，应引导用户完成模型配置（交互式或文档链接），而不是静默降级为「无 AI」模式。

#### AI Agent

基于 Vercel AI SDK，**依赖上述模型配置**，支持多 provider：
- System Prompt 包含环境信息（OS、已装软件、PATH、错误日志等）
- 多轮对话保持上下文
- Function calling：让 AI 直接触发安装、配置、服务启停（用户确认后）

#### Serve / Configure（服务与配置执行层）

- **configure** — 根据已安装软件和 config 中的 `env`，生成并写入 shell profile（或输出 diff / --dry-run）
- **serve** — 对声明了 `service: true` 的软件，提供 start / stop / status（封装 brew services、systemd、launchd 等）
- 安装器可暴露 `getEnv()` / `getServiceName()`，供该层统一调用

### 4.3 目录结构

```
envready/
├── src/
│   ├── index.ts              # CLI 入口 (yargs)
│   ├── cli/
│   │   ├── cmd/
│   │   │   ├── detect.ts     # detect 命令
│   │   │   ├── install.ts    # install 命令
│   │   │   ├── list.ts       # list 命令
│   │   │   ├── apply.ts      # apply 命令
│   │   │   ├── chat.ts       # chat 命令（AI 对话）
│   │   │   ├── configure.ts  # 环境变量写入（含 --dry-run）
│   │   │   └── serve.ts     # 服务启停（start/stop/status）
│   │   └── ui.ts             # CLI UI 工具（颜色、表格、logo）
│   ├── installer/
│   │   ├── installer.ts      # Installer 接口定义
│   │   ├── registry.ts       # 安装器注册表
│   │   └── installers/       # 各软件安装器
│   │       ├── node.ts
│   │       ├── python.ts
│   │       ├── go.ts
│   │       ├── rust.ts
│   │       └── docker.ts
│   ├── detect/
│   │   ├── os.ts             # OS 检测
│   │   ├── software.ts       # 软件检测
│   │   └── env.ts            # 环境变量分析
│   ├── ai/
│   │   └── agent.ts          # AI Agent
│   ├── config/
│   │   ├── config.ts         # 配置加载
│   │   └── schema.ts         # 配置 Schema (Zod)
│   ├── executor/
│   │   └── shell.ts          # Shell 命令执行
│   └── util/
│       └── log.ts            # 日志工具
├── test/
│   └── detect.test.ts        # 检测层测试
├── envready.example.yaml     # 配置文件示例
├── package.json
├── tsconfig.json
└── DESIGN.md                 # 本文档
```

## 5. 技术栈

| 层 | 技术 | 选型理由 |
|----|------|----------|
| 运行时 | Bun | 快速启动、内置 TS 支持、优秀的工具链 |
| CLI 框架 | yargs | 成熟稳定、类型友好、自动帮助文档 |
| 校验 | Zod | 类型推导 + 运行时校验一体 |
| 终端美化 | chalk + ora | 彩色输出 + 加载动画 |
| AI | Vercel AI SDK | 多 Provider、流式输出、Function Calling |
| 配置 | yaml | YAML 对人类友好，适合配置文件 |
| 测试 | bun:test | 内置测试框架，零配置 |

## 6. 迭代路线图

### Phase 0 — MVP（当前）
**目标**：CLI 能检测环境、安装常见工具、AI 基础对话

- [x] 项目框架搭建
- [x] 环境检测 (detect)
- [x] 5 个安装器 (node/python/go/rust/docker)
- [x] 安装命令 (install)
- [x] 配置文件支持 (apply)
- [x] AI 对话脚手架 (chat)
- [ ] **模型配置**：全局/项目 model 配置、首次使用引导、多 Provider
- [ ] 更多安装器 (java, ruby, php, nginx, redis, mysql, postgresql)
- [ ] AI function calling（让 AI 直接触发安装）
- [ ] **服务启动与环境配置**：`configure` 写环境变量、`serve start/stop` 管理服务、config 中 `env` / `service`
- [ ] 安装日志记录和回滚

### Phase 1 — 体验提升
**目标**：TUI 交互、更好的 AI 集成

- [ ] TUI 界面（类似 opencode 的 SolidJS + OpenTUI 方案）
- [ ] 安装进度实时展示
- [ ] 环境快照和还原（snapshot / restore）
- [ ] AI 流式输出
- [ ] AI 自动执行命令（用户确认后）
- [ ] 多 AI Provider 支持（OpenAI / Anthropic / 本地 Ollama）
- [ ] 错误自动诊断 + 修复建议

### Phase 2 — 普适化
**目标**：面向普通用户的图形界面

- [ ] REST API 服务端（借鉴 opencode 的 Hono 架构）
- [ ] Web UI（SolidJS / React）
- [ ] 预设模板："前端开发套装"、"数据科学套装"、"DevOps 套装"
- [ ] 安装向导（步骤式引导）
- [ ] 权限管理（sudo 操作明确提示）
- [ ] 多语言支持（中/英）
- [ ] Desktop App（Tauri，借鉴 opencode）

### Phase 3 — 生态
**目标**：社区化、插件化

- [ ] 插件系统（用户自定义安装器）
- [ ] 社区模板市场
- [ ] 安装知识库（常见问题 + 解决方案）
- [ ] CI/CD 集成（GitHub Actions 等）
- [ ] 团队管理功能
- [ ] Windows 完整支持

## 7. 使用场景详细设计

### 7.1 新机器初始化

```
用户拿到新 MacBook
→ 安装 Bun: curl -fsSL https://bun.sh/install | bash
→ 安装 envready: bun install -g envready
→ 设置 AI key: export OPENAI_API_KEY=sk-...
→ 自然语言输入: envready install "全栈开发环境，Node + Python + Docker"
→ AI 推荐方案 → 用户确认 → 自动安装
→ 等待 5 分钟，所有开发工具就绪
```

### 7.2 新人入职

```
新人 clone 团队仓库
→ 仓库内有 envready.yaml
→ 执行: envready apply
→ 环境与团队一致
→ 遇到问题: envready chat "安装 node 时报错 permission denied"
→ AI 诊断并给出解决方案
```

### 7.3 安装小众工具

```
用户: envready install ripgrep
→ 本地安装器不存在
→ AI 自动生成安装方案（检测 OS → brew install ripgrep）
→ 用户确认 → 执行安装
→ 验证成功 ✅
```

### 7.4 环境排障

```
用户: envready chat
> "我的 python 命令指向 2.7 而不是 3.12"
AI 分析 PATH、检测 pyenv、识别 shell 配置问题
→ "你的 ~/.zshrc 中缺少 pyenv init，我帮你加上？"
→ 用户确认 → 自动修复
```

### 7.4 Web UI 版本（Phase 2）

```
普通用户打开 localhost:3000
→ 看到一个干净的界面，列出可安装的软件
→ 勾选 Python、VS Code、Docker
→ 点击"一键安装"
→ 进度条 + 实时日志
→ 遇到问题 → 聊天气泡弹出 AI 建议
→ 安装完成 → 验证结果 ✅
```

## 8. 与 OpenCode 的架构对比

| 维度 | OpenCode | envready | 借鉴点 |
|------|----------|----------|--------|
| 核心模式 | Tool.define() | Installer.define() | 相同的插件化模式 |
| CLI 框架 | yargs | yargs | 直接采用 |
| 服务端 | Hono REST + SSE | 未来 Phase 2 | 架构思路 |
| AI 集成 | Vercel AI SDK | Vercel AI SDK | 直接采用 |
| TUI | SolidJS + OpenTUI | 未来 Phase 1 | 技术选型 |
| Desktop | Tauri | 未来 Phase 2 | 技术选型 |
| 插件 | Plugin hooks | 未来 Phase 3 | hook 机制 |
| 配置 | JSON/JSONC 分层 | YAML 分层 | 分层策略 |
| 权限 | allow/ask/deny | 未来 Phase 2 | 三级权限 |
| 会话 | Session + Storage | 安装历史 + 日志 | 状态管理 |

## 9. 设计原则

1. **安全第一** — 危险操作必须用户确认，每步可回滚
2. **幂等操作** — 重复执行不会破坏已有配置
3. **渐进式** — 从 CLI 开始，逐步扩展到 TUI、Web、Desktop
4. **模型配置是核心前置** — 用户需求理解、已安装排重、排障、环境变量生成等都依赖模型，需显式配置并引导用户完成
5. **跨平台** — 核心逻辑平台无关，安装器各自适配
6. **透明可控** — 用户永远知道正在发生什么

## 10. 竞品分析

| 工具 | 优势 | 劣势 | envready 的差异 |
|------|------|------|----------------|
| Homebrew | 生态丰富、社区活跃 | 仅 macOS/Linux、无 AI、无环境配置、小众软件需人工维护 | AI 推荐 + 长尾覆盖 + 跨平台配置 |
| nix | 声明式、可复现 | 学习曲线陡峭 | 更友好的声明式 + AI 自然语言交互 |
| Ansible | 强大的自动化 | 太重、面向运维 | 面向个人开发者、轻量、AI 驱动 |
| devcontainer | 完全隔离的环境 | 需要 Docker、资源消耗大 | 原生安装、零额外开销 |
| asdf | 多语言版本管理 | 仅版本管理、无安装引导 | 完整的安装+配置+排障 |

## 11. 度量指标

### 核心指标
- **安装成功率** — 目标 > 95%
- **首次安装耗时** — 目标 < 5 分钟完成基础环境
- **AI 排障解决率** — 目标 > 80% 的常见问题一次解决

### 用户体验指标
- **命令数量** — 用户达成目标所需的命令数（越少越好）
- **错误恢复时间** — 从报错到解决的平均时间
- **配置文件采纳率** — 使用 envready.yaml 的项目比例

---

*文档版本: v0.2.0 | 最后更新: 2026-02-13*
