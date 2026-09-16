# ds-agent

DeepSeek Harness（dsh）插件化智能体的 Electron 桌面外壳：流式对话、工具调用、审批弹窗、Bundle 管理，开箱即用无需在本机安装 Node 或 dsh。

## 架构

```
┌─────────────────────┐   Electron IPC    ┌──────────────────────────┐  NDJSON/stdio  ┌────────────────┐
│  渲染进程（React）    │ ◄───────────────► │  主进程                   │ ◄────────────► │  引擎 Sidecar   │
│  kernel-events.ts    │    engine:* 频道   │  DshEngineManager        │  stdin/stdout  │  dsh | mock    │
│  （全局事件订阅器）    │                   │  （Sidecar 生命周期管理）  │                │                │
└─────────────────────┘                   └──────────────────────────┘                └────────────────┘
```

三层职责：

| 层 | 关键文件 | 职责 |
| --- | --- | --- |
| 协议定义 | `src/shared/protocol.ts` | 外壳↔引擎事件/命令的类型与语义（点分命名，单一事实来源） |
| 引擎管理 | `src/main/engine/engine-manager.ts` | spawn / 崩溃自动重启（快速失败）/ ready 看门狗 / Mock 切换 |
| dsh 适配 | `src/main/engine/dsh-process.ts` | ACP 客户端：JSON-RPC 握手、session/update → 协议事件翻译、审批往返 |
| Mock 引擎 | `src/main/engine/mock-engine.ts` | 与 dsh 同构的确定性引擎，无 dsh 时驱动完整 UI 流程 |
| IPC 中继 | `src/main/ipc.ts` + `src/preload/index.ts` | 渲染层命令 → 管理器；管理器事件 → 渲染层 |
| UI | `src/renderer/src/` | React 19 + zustand：流式对话、工具卡片、审批弹窗、Bundle 开关 |

要点：

- **dsh 走 ACP 通道**（`dsh --profile acp`，JSON-RPC 2.0 over NDJSON/stdio），适配层把外壳协议帧翻译为 ACP 方法调用，映射表见 [docs/protocol.md](docs/protocol.md) 第 10 节
- **捆绑运行时**：vendor 捆绑的 dsh 由 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` 拉起，分发自包含；也可在设置中指定外部 dsh 路径或走 PATH 检测，均不可用时回退 mock
- **外壳与引擎解耦**：dsh 处于 developer preview，原生 schema 未冻结，引擎差异统一收敛在适配层

## 环境要求

- Node.js ≥ 20（仅开发时需要；打包后用户机器无需 Node）
- npm（主项目依赖）+ pnpm（vendor 的 dsh 运行时）

## 快速开始

```bash
# 1. 安装依赖（.npmrc 已配置 npmmirror 与 electron 镜像）
npm install

# 2. 安装 vendor 捆绑的 dsh 运行时（首次克隆后执行一次；用 pnpm——npm 会卡死 dsh 的 600+ 包依赖树）
#    vendor/dsh     = acp 外壳运行时（dsh 0.1.5-rc.1）
#    vendor/dsh-web = web + DirectorX 运行时（dsh 0.1.1-rc.2）
pnpm --dir vendor/dsh install
pnpm --dir vendor/dsh-web install

# 3. 设置 DeepSeek API Key（dsh 凭据分层中进程环境优先级最高）
#    PowerShell：$env:DEEPSEEK_API_KEY = "sk-…"

# 4. 启动
npm run dev
```

> 未设置 API Key 时引擎仍可启动（握手正常），`session/prompt` 会报错；也可以把 `forceMock` 设为 `true` 用 mock 引擎体验完整 UI 流程。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式（electron-vite，热重载） |
| `npm run build` | 构建产物到 `out/` |
| `npm run preview` | 运行构建产物 |
| `npm run typecheck` | TypeScript 类型检查 |

## 配置

配置存于 `%APPDATA%/ds-agent/config.json`（应用内设置页可视化编辑）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `profile` | `acp` | dsh profile 名（`~/.dsh/profiles/` 下） |
| `forceMock` | `false` | 强制使用 mock 引擎 |
| `dshPath` | 空 | 外部 dsh 可执行文件路径（留空走 vendor 捆绑 → PATH 检测 → mock 回退） |
| `workspaceDir` | 空 | 引擎工作目录 |

Bundle 启用状态存于 dsh profile 装载清单（`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 数组），与官方 `dsh plugin` 机制同构，开关后重启引擎生效。

## 更多文档

- [docs/protocol.md](docs/protocol.md) — 外壳↔引擎通信协议规范：事件/命令参考、典型时序、ACP 翻译层映射、vendor 目录契约与实测记录
