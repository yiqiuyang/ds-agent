# DSH 桌面外壳与内核通信协议

- 版本：v0.3（内部规范）
- 代码映射：事件与命令的 TypeScript 定义在 [src/shared/protocol.ts](../src/shared/protocol.ts)，本文档与其同步演进
- 背景：dsh（DeepSeek Harness）处于 developer preview，原生事件 schema **未冻结**。因此本协议是外壳自定义的稳定层，引擎差异统一收敛在适配层（见第 10 节），协议其余部分（IPC、渲染、Mock）不感知引擎细节

---

## 1. 架构与分层

```
┌─────────────────────┐   Electron IPC    ┌──────────────────────────┐  NDJSON/stdio  ┌────────────────┐
│  渲染进程（React）    │ ◄───────────────► │  主进程                   │ ◄────────────► │  引擎 Sidecar   │
│  kernel-events.ts    │    engine:* 频道   │  DshEngineManager        │  stdin/stdout  │  dsh | mock    │
│  （全局事件订阅器）    │                   │  （Sidecar 生命周期管理）  │                │                │
└─────────────────────┘                   └──────────────────────────┘                └────────────────┘
```

引擎 Sidecar 运行时来源（见第 12 节）：vendor 捆绑的 dsh 由 **Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`** 拉起（分发自包含，用户机器无需安装 Node/dsh）；外部安装的 dsh 走命令模式。

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 协议定义 | `src/shared/protocol.ts` | 事件、命令、状态、配置的类型与语义（单一事实来源） |
| 引擎管理 | `src/main/engine/engine-manager.ts` | spawn / 停止 / 自动重启 / Mock 切换 / ready 看门狗 |
| dsh 适配 | `src/main/engine/dsh-process.ts` | 子进程 spawn（捆绑运行时 / 外部命令双模式）、NDJSON 行解析、原生事件 ↔ 协议双向转换 |
| Mock 引擎 | `src/main/engine/mock-engine.ts` | 与 dsh 同构的确定性引擎，无 dsh 时驱动完整 UI 流程 |
| IPC 中继 | `src/main/ipc.ts` + `src/preload/index.ts` | 渲染层命令 → 管理器；管理器事件 → 渲染层 |
| UI 事件流 | `src/renderer/src/kernel-events.ts` | 全局事件订阅器：事件 → UI 状态映射 |

## 2. 传输层规范

- **NDJSON over stdio**：一行一个 JSON 对象，UTF-8 编码，`\n` 分隔
- **stdout** 只承载事件流；**stderr** 只承载引擎日志（外壳仅记录，不解析、不进消息流）
- 外壳侧按 chunk 收到 stdout 后需做**行缓冲**（一个 JSON 对象可能跨多个 chunk）
- 单行 JSON 解析失败：**丢弃该行**并记 `console.warn`，不中断事件流（半行、引擎杂音均可能发生）
- 外壳向引擎 stdin 写命令，同样一行一个 JSON，写失败视为引擎不可用

## 3. 命名与演进规则

- 消息命名：`<对象>.<动作>`（如 `message.delta`、`permission.request`），字段 camelCase
- **未知事件一律忽略并告警**，保证协议向前兼容
- 引擎原生差异（事件名、字段名）只允许修改适配层 `dsh-process.ts`；禁止在 IPC、渲染层出现 `snake_case` 或引擎专有字段

## 4. 生命周期

`EngineStatus` 状态机（渲染层视角，由事件推导 + `engine.status` 上报）：

```
starting ──► ready ◄──────────── turn.end（完成/中断）──────────────┐
   ▲           │  ▲                                                  │
   │           │  └── permission.response ──┐                        │
   │           ▼        ▲                   │                        │
   │         busy ──► waiting_permission ───┘                        │
   │           ▲        │                                            │
   │           └ message.start（渲染层推导）                           │
   │                                                                │
   │        崩溃（engine.exited，非用户停止）                          │
   └── restarting ◄──────────── 自动重启退避（1s/2s/3s，上限 3 次）    │
                  └── 上限耗尽 ──► error（等待手动重启）               │
ready ── engine.error(fatal) ──► error
任意状态 ── 用户主动停止 ──► exited（终态，无自动恢复）
```

简化表述：`ready / busy / waiting_permission` 由一轮交互内的事件驱动；`starting / restarting` 由主进程上报；`error / exited` 为终态。

| 状态 | 触发来源 | 语义 |
| --- | --- | --- |
| `starting` | `engine.status` | 管理器正在拉起引擎进程 |
| `ready` | `engine.ready` / `turn.end` | 引擎可用，可接受输入 |
| `busy` | `message.start`（渲染层推导） | 一轮交互执行中 |
| `waiting_permission` | `permission.request`（渲染层推导） | 等待用户审批 |
| `restarting` | `engine.status` | 崩溃后自动重启中（含退避等待） |
| `exited` | `engine.exited` | 进程已退出且不会自动恢复 |
| `error` | `engine.error(fatal)` | 致命错误，等待用户手动重启 |

生命周期关键事件：

- `engine.ready`：引擎握手完成，**会话起点**。渲染层收到后重置时间线、清空未决审批
- `engine.exited`：仅由主进程在子进程退出时上报；随后若满足自动重启条件，会紧跟 `engine.status(restarting)`
- `engine.status`：管理器主动上报的 `starting` / `restarting` 等状态（`ready` 由 `engine.ready` 表达，不走此事件）

## 5. 事件参考（内核 → 外壳）

### 5.1 engine.ready

引擎握手完成。渲染层据此开启新会话。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `engine` | `'dsh' \| 'mock'` | 是 | 引擎种类 |
| `agent` | `string` | 是 | 引擎标识，如 `'dsh'` / `'mock-engine'` |
| `version` | `string` | 否 | 引擎版本 |
| `model` | `string` | 否 | 当前模型 / profile 描述 |

### 5.2 engine.status

管理器上报的生命周期状态变更。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | `EngineStatus` | 是 | 当前状态 |
| `message` | `string` | 否 | 人类可读说明（如自动重启原因） |

### 5.3 message.start / message.delta / message.end

一条助手消息的流式输出。`start` 与 `end` 之间 `delta` 可出现任意次，按序追加。

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `message.start` | `messageId: string` | 消息开始，UI 建立空消息占位 |
| `message.delta` | `messageId: string`、`text: string` | 增量文本，UI 追加 |
| `message.end` | `messageId: string`、`stopReason?: 'stop' \| 'tool_use' \| 'interrupted' \| 'error'` | 消息结束；`tool_use` 表示后面紧跟 `tool.call` |

### 5.4 tool.call / tool.result

工具调用及其结果，以 `callId` 关联。

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `tool.call` | `callId: string`、`tool: string`、`input: unknown` | 引擎请求执行工具；危险工具随后会触发 `permission.request` |
| `tool.result` | `callId: string`、`ok: boolean`、`output: string` | 执行结果，`output` 为文本摘要 |

### 5.5 permission.request

引擎请求用户授权（通常发生在 `tool.call` 之后、`tool.result` 之前）。渲染层收到后**弹出审批弹窗**，会话进入 `waiting_permission`，直到收到对应 `permission.response` 命令或本轮被中断。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `requestId: string` | 是 | 审批请求标识，响应时原样带回 |  |
| `callId` | `string` | 否 | 关联的工具调用 |
| `tool` | `string` | 是 | 请求授权的工具名 |
| `input` | `unknown` | 是 | 工具入参（供用户审阅） |
| `reason` | `string` | 否 | 引擎给出的说明 |

### 5.6 turn.end

一轮用户输入驱动的完整交互结束。渲染层将未决审批标记为拒绝、关闭弹窗、回到 `ready`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `reason` | `'done' \| 'interrupted' \| 'error'` | 是 | 正常完成 / 被中断 / 出错 |

### 5.7 engine.error

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | `string` | 是 | 错误描述 |
| `fatal` | `boolean` | 否 | 致命：引擎不可用。`true` 时渲染层进入 `error` 状态并提示手动重启；`false` 仅记录 |

### 5.8 engine.exited

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | `number \| null` | 是 | 退出码，被信号杀死时为 `null` |
| `signal` | `string` | 否 | 终止信号（POSIX） |

### 5.9 session.list

`session.list` 命令的应答（异步事件，无请求关联 id）。dsh 仅回传 `sessionId` 与 `cwd`（不回传标题/时间），按创建时间倒序；当前活跃会话不会出现在列表中。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessions` | `{ sessionId: string; cwd: string }[]` | 是 | 本页条目 |
| `cursor` | `string` | 否 | 本次请求使用的续页游标（渲染端据此判定追加还是替换） |
| `nextCursor` | `string` | 否 | 有更多页时的续页游标 |

### 5.10 session.switched

会话切换完成（`session.new` / `session.resume` 的应答）。渲染层重置时间线；**ACP resume 不回放历史**，历史上下文保留在引擎侧（持久化 JSONL），UI 以系统提示说明。字段：`sessionId: string`、`kind: 'new' \| 'resumed'`、`model?: string`。

## 6. 命令参考（外壳 → 内核）

| 命令 | 字段 | 说明 |
| --- | --- | --- |
| `user.input` | `text: string` | 用户输入，开启新一轮交互 |
| `permission.response` | `requestId: string`、`decision: 'allow_once' \| 'allow_always' \| 'deny'` | 对 `permission.request` 的应答；`allow_always` 表示本会话内同名工具不再询问 |
| `interrupt` | — | 中断当前轮，引擎应以 `turn.end(interrupted)` 收尾 |
| `session.list` | `cursor?: string` | 列出当前工作区可恢复的历史会话；应答为 `session.list` 事件（5.9） |
| `session.new` | — | 新建会话并切换为当前会话；旧会话自动关闭（数据已持久化，可再次恢复）；应答为 `session.switched` 事件（5.10） |
| `session.resume` | `sessionId: string` | 恢复历史会话为当前会话；应答为 `session.switched` 事件（5.10） |

会话切换守卫：当前轮 prompt 在途或审批未决时，引擎拒绝 `session.new` / `session.resume`（非致命 `engine.error`）；`session.list` 不受限。

## 7. 典型时序

### 7.1 纯文本回复

```
外壳 ► user.input {text}
内核 ◄ message.start {messageId}
内核 ◄ message.delta × N
内核 ◄ message.end {messageId, stopReason: 'stop'}
内核 ◄ turn.end {reason: 'done'}
```

### 7.2 工具调用 + 审批

```
外壳 ► user.input
内核 ◄ message.start / message.delta… / message.end {stopReason: 'tool_use'}
内核 ◄ tool.call {callId, tool: 'write_file', input}
内核 ◄ permission.request {requestId, callId, tool, input}
外壳 ► permission.response {requestId, decision: 'allow_once'}
内核 ◄ tool.result {callId, ok: true, output}
内核 ◄ message.start / message.delta… / message.end
内核 ◄ turn.end {reason: 'done'}
```

拒绝（`decision: 'deny'`）时引擎应回 `tool.result {ok: false}` 并以正常消息收尾；中断时未决审批按拒绝处理。

### 7.3 进程崩溃自动重启

```
内核 ◄ engine.exited {code: 1}                       # 非用户主动停止
内核 ◄ engine.status {status: 'restarting', message: '…1s 后自动重启（第 1/3 次）'}
（退避 1s/2s/3s）
内核 ◄ engine.status {status: 'starting'}
内核 ◄ engine.ready {…}                               # 时间线重置，新会话
```

## 8. 错误处理与重启策略

| 场景 | 行为 |
| --- | --- |
| 未检测到 dsh / `forceMock` / dsh spawn 失败 | 自动回退 Mock 引擎（回退时上报非致命 `engine.error` 说明原因） |
| 子进程异常退出（非用户停止） | 自动重启：上限 3 次，退避 1s → 2s → 3s |
| **启动后 < 10s 退出，且连续 2 次** | **快速失败**：判定为确定性失败（配置/协议不匹配，重启必败），直接上报致命 `engine.error`，不再重启 |
| 稳定运行 ≥ 15s 后再崩溃 | 重启计数与快速退出计数清零（区分「崩溃循环」与「偶发退出」）；收到 `engine.ready` 同样清零快速退出计数 |
| 自动重启上限耗尽 | 上报致命 `engine.error`，进入 `error`，等待手动重启 |
| 启动后 15s **静默**（未收到 `engine.ready` 且无任何 stdout/stderr 输出） | 看门狗触发：终止进程并上报致命 `engine.error`（不自动重启，避免配置错误导致的循环） |
| 启动等待期间引擎有任何 I/O 活动 | 看门狗**滑动重置**（不杀正在初始化的引擎，如 dsh 首次 profile 安装依赖的长静默期） |
| 用户主动 stop / 重启 | 不触发自动重启 |

## 9. 渲染层 IPC 中继

主进程与渲染进程之间的事件/命令按以下频道中继（载荷即协议对象，不二次封装）：

| 频道 | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `engine:event` | main → renderer | `KernelEvent` | 引擎事件推送（单播到未销毁窗口） |
| `engine:start` | renderer → main | — → `'dsh' \| 'mock'` | 启动引擎（幂等，重复调用先停旧进程） |
| `engine:restart` | renderer → main | — → `'dsh' \| 'mock'` | 以当前配置重启 |
| `engine:send` | renderer → main | `text: string` | 转为 `user.input` |
| `engine:permission` | renderer → main | `requestId, decision` | 转为 `permission.response` |
| `engine:interrupt` | renderer → main | — | 转为 `interrupt` |
| `config:get` / `config:set` | 双向 | `ShellConfig` | 外壳配置持久化（dshPath / profile / workspaceDir / forceMock） |
| `bundles:get` | renderer → main | — → `BundleProfile` | 读取当前 profile 的 bundle 状态 + 已安装 bundle 池 |
| `bundles:setEnabled` | renderer → main | `id, enabled` → `BundleProfile` | 编辑 profile 的 `dsh.profile.bundles` 数组（启用追加 / 禁用移除） |

Bundle 机制（对齐 dsh 装载语义，实证见 12.5）：dsh 每次启动读 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`（包名数组，顺序即层叠序）逐层挂载；官方 `dsh plugin` 的 reconcile 也是直接改写该文件（`JSON 2 空格 + \n`）。外壳开关 = 编辑该数组，与官方机制同构，**重启引擎后生效**（UI 提供重启按钮）。bundle 池 = vendor 安装（in-box）与 `~/.dsh/profiles/node_modules` 中声明 `dsh.bundle` 的包，包解析 vendor 锚点优先（acp profile 本地 node_modules 为空即走 vendor）。外壳配置不再存 bundle 启用表（单一状态源 = profile 数组）。

## 10. ACP 翻译层（dsh-process.ts 适配映射）

适配集中在 `src/main/engine/dsh-process.ts`。dsh 经 `--profile acp` 长驻运行 `@deepseek-ai/dsh-acp`，对外暴露 **ACP（Agent Client Protocol）**：JSON-RPC 2.0 over NDJSON/stdio（每行一个 JSON 消息，非 LSP Content-Length framing）。外壳充当 ACP 客户端，把本协议的命令/事件与 ACP 方法双向翻译。

### 10.1 握手链（start → engine.ready）

```
外壳                          dsh-acp
 │ initialize(protocolVersion:1, clientCapabilities) │
 │──────────────────────────────────────────────────>│
 │◄──────────────────────────────────────────────────│ agentInfo(name, version)
 │ initialized（通知）                                 │
 │──────────────────────────────────────────────────>│
 │ session/new(cwd, mcpServers:[])                    │
 │──────────────────────────────────────────────────>│
 │◄──────────────────────────────────────────────────│ sessionId, configOptions
 │ engine.ready（协议事件）                            │
```

握手失败（initialize / session/new 返回 error 或空响应）→ `engine.error`（fatal）。当前模型名从 `configOptions` 中 id 为 `model` 的选项的 `currentValue`（JSON 字符串数组，取 `[1]`）宽容提取，失败时省略。

### 10.2 命令翻译（外壳 → ACP）

| 协议命令 | ACP 方法 | 说明 |
| --- | --- | --- |
| `user.input` | `session/prompt` 请求 | `prompt: [{type:'text', text}]`；sessionId 未就绪时非致命 `engine.error` |
| `session.list` | `session/list` 请求 | `{cwd, cursor?}`；应答宽容解析为 `session.list` 事件（dsh 仅回传 sessionId/cwd，活跃会话被过滤） |
| `session.new` | `session/new` 请求（复用握手方法） | 成功后先注册新会话，再 `session/close` 旧会话、广播 `session.switched(new)`；prompt 在途/审批未决时拒绝 |
| `session.resume` | `session/resume` 请求 | `{sessionId, cwd, mcpServers: []}`；cwd 必须与目标会话持久化 cwd 物理同目录（dsh 校验）；目标会话在本连接内已激活时直接切回（不重复 resume，dsh 会拒绝重复激活）；成功后关闭旧会话并广播 `session.switched(resumed)` |
| `permission.response` | `session/request_permission` 的响应 | 按选项 kind 回退链匹配：`allow_always`→`allow_always`→`allow_once`、`allow_once`→`allow_once`、`deny`→`reject_once`→`reject_always`（dsh-acp 实测仅提供 allow_once/reject_once 两选项）；无匹配选项以 JSON-RPC error 响应（agent 按 cancelled 处理） |
| `interrupt` | `session/cancel` 通知 | — |

### 10.3 事件翻译（ACP → 协议）

| ACP 消息 | 协议事件 | 说明 |
| --- | --- | --- |
| `session/update`（`agent_message_chunk`） | `message.start` / `message.delta` / `message.end` | 流式；`messageId` 变化即先收尾旧流再开新流 |
| `session/update`（`agent_thought_chunk`） | 同上（thought 流） | 协议 id 前缀 `thought_N`；与 message 流各自独立（各至多一条打开） |
| `session/update`（`tool_call`） | `message.end(tool_use)` + `tool.call` | 工具调用前收尾打开的消息流，保证 `message.end` → `tool.call` 时序；同时记录进 `toolCalls` 注册表（tool 取 `name` 回退 `title`，dsh-acp 实测无 `name` 字段） |
| `session/update`（`tool_call_update`） | `tool.result` | 仅 `status: completed/failed`；输出取 content text 块拼接（含嵌套 `{type:'content'}` 形态，见 12.5.2），回退 `rawOutput` |
| `session/request_permission`（请求） | `permission.request` | `requestId = perm_<rpcId>`；toolCall 仅含 toolCallId，经 `toolCalls` 注册表回查补全 tool/input；响应见 10.2 |
| `session/prompt` 响应 | `turn.end` | stopReason 映射见下表；出错时先发错误消息流 + 非致命 `engine.error` + `turn.end('error')` |
| `session/new` 响应（握手 + session.new 命令） | `engine.ready`（含 `sessionId`）/ `session.switched` | configOptions 中解析当前模型随事件携带 |
| `session/list` 响应 | `session.list` | 透传 sessions + nextCursor，附请求 cursor |
| `session/resume` 响应 | `session.switched`（kind=resumed） | `{configOptions}`，**不回放历史**；历史上下文保留在引擎侧持久化 JSONL |
| `session/close` 响应 | —（仅 warn 失败） | 会话数据已持久化，关闭后重新出现在 session/list |
| 其余 update（plan/usage/compaction 等） | 忽略（warn） | 未知 update 类型向前兼容 |

`stopReason` 映射：`end_turn`→`done`；`cancelled`→`interrupted`；`max_tokens` / `max_turn_requests` / `refusal`→`error`；未知值按 `done`。

### 10.4 生命周期与退出

- `kill()`：先 `stdin.end()`（ACP server 在 stdin EOF 时优雅退出）再 `child.kill()`。
- 引擎发起的未知 JSON-RPC 请求回 `-32601 Method not found`，避免引擎侧挂起。
- dsh-acp 的 stderr 转发主进程控制台（`[dsh]` 前缀），不进入消息流。
- ACP 版本契约：`@agentclientprotocol/sdk` 1.4.0、protocolVersion 1。dsh 升级改变 ACP 方法/字段时**只改此表与 dsh-process.ts**。

## 11. Mock 引擎

`MockEngine` 实现与 `DshProcess` 相同的 `EngineProcess` 接口：

- `start()` 延迟 200ms 后发出 `engine.ready`（模拟启动）
- `user.input` 触发一轮确定性演示：流式回复 → `tool.call(write_file)` → `permission.request`（等待审批，可被 `interrupt` 以拒绝结算）→ `tool.result` → 总结回复 → `turn.end`
- `allow_always` 后同名工具本会话内直接放行；`kill()` 后停止所有演示
- Mock 不会退出，永不触发 `engine.exited` / 自动重启

## 12. vendor 目录契约（捆绑运行时）

### 12.1 目录布局与安装

```
vendor/dsh/
├── package.json          # 仅一个依赖：@deepseek-ai/dsh
├── package-lock.json     # 版本锁定（提交进仓库）
└── node_modules/         # 安装产物（.gitignore 的 node_modules/ 规则已覆盖）
    └── @deepseek-ai/dsh/ # bin 入口 lib/bin.js
```

安装 / 升级（仓库根目录执行；本机网络注意事项见项目记忆，必要时 `--userconfig <空配置>` 绕过用户级代理）：

```powershell
npm install --prefix vendor/dsh @deepseek-ai/dsh --registry=https://registry.npmmirror.com
```

### 12.2 打包映射

`package.json` → `build.extraResources` 将 `vendor/dsh` 复制进安装包 `resources/dsh`；`bundledDshRoot()` 按 `app.isPackaged` 定位：

- 开发态：`app.getAppPath()/vendor/dsh`
- 打包态：`process.resourcesPath/dsh`

分发包自包含，用户机器**无需安装 Node.js 与 dsh**。

### 12.3 捆绑运行时原理

不额外捆绑 Node.js，复用 Electron 二进制作纯 Node（`node` 模式 spawn）：

```
spawn(process.execPath, [entry, '--profile', profile], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
```

- `ELECTRON_RUN_AS_NODE=1` 使 Electron 以纯 Node 模式执行 JS 入口，行为与系统 Node 等价
- 参数走数组传递、不经 shell：无注入面，也不存在 Windows `.cmd` 兼容问题（`command` 模式仍需经 shell）

### 12.4 启动解析链（`resolveDshLaunch`）

| 优先级 | 来源 | 模式 | 说明 |
| --- | --- | --- | --- |
| 1 | 显式 `dshPath` 配置 | `command` | `--version` 探测通过才启用，否则返回 null（不回退低优先级） |
| 2 | vendor 捆绑 | `node` | 读捆绑包 `package.json` 的 `bin` 字段解析入口 |
| 3 | PATH 中的 `dsh` / `dsh.cmd` | `command` | Windows 兼容 `.cmd` |
| — | 均不可用 | — | 回退 Mock（第 8 节） |

### 12.5 dsh 0.1.5-rc.1 探测记录（ELECTRON_RUN_AS_NODE 实测）

| 探测 | 结果 |
| --- | --- |
| bin 入口 | `lib/bin.js`（ESM，包 `"type": "module"`） |
| `--version` | `0.1.5-rc.1`，捆绑运行时通路验证通过 |
| `--help` | 子命令 `web` / `plugin`；`--profile <name>` 启动 `$DSH_HOME/profiles` 下的 profile |
| `--profile headless --help` | **一次性任务模式**：流式 reasoning 走 stderr、最终 assistant 消息打印 stdout 后进程退出 |
| 首次 spawn（Electron 冒烟实测） | **无 task 的 `--profile <name>` 在 CLI 层约 5.9s 报 `a task is required` 退出（code=1），不做 profile 初始化**；profile 初始化发生在首次带 task 执行时（`~/.dsh/profiles/<name>` 拷贝模板 + pnpm 装依赖，可达数分钟，零 stdout）——该场景才会撞上第 8 节 15s ready 看门狗 |
| 无 task spawn 的外壳表现（修复前 40s 实测） | 看门狗**不触发**（dsh 6s 即死）；实际走「退出 → 自动重启 ×3（退避 1s/2s/3s）→ fatal `engine.error`（多次异常退出）」循环，总时长约 30s，UI 终态 `error` |
| 同上（快速失败修复后 25s 实测） | 连续 2 次「启动即退出」→ 直接 fatal `engine.error`（引擎启动后立即退出，疑似配置或协议不匹配），总时长约 13s，stderr 2 行；Mock 路径不受影响（forceMock 时零 dsh 拉起） |
| profiles 依赖树 | 含 `@agentclientprotocol` —— ACP（JSON-RPC over stdio，Zed 推动的编辑器↔agent 协议）可能是官方的编辑器集成通道，校准时优先评估 |
| **`--profile acp` 实战探测**（ELECTRON_RUN_AS_NODE 实测） | **ACP 通路完全可用**，详见下表 |

#### 12.5.1 ACP 实测记录（2026-09-15，`dsh --profile acp`）

| 项 | 结果 |
| --- | --- |
| 启动方式 | `dsh --profile acp`（**零参数**）；acp-app CLI：Serve automation clients over ACP stdio；stdin EOF 退出 |
| 进程形态 | **长驻 sidecar**：90s 观察窗内不退出，stdout 等待 JSON-RPC 请求 |
| 传输层 | JSON-RPC 2.0 over **NDJSON**（一行一个 JSON + `\n`）——**非标准 LSP `Content-Length` framing**（实测发 LSP framing 报 `-32700 Parse error`） |
| `initialize` 响应 | `agentInfo: deepseek-harness-acp`、`protocolVersion: 1`、sessionCapabilities `{close, list, resume}`（会话持久化）、`mcpCapabilities.http`、无 image/audio/embeddedContext |
| `session/new` 响应 | `sessionId` + `configOptions`：model（DeepSeek V4-Flash / V4-Pro / V41-Flash / V4-Flash-Vision-Exp，当前 V4-Flash）、reasoning_effort（off/low/…，当前 high） |
| 事件投影（dsh-acp 类型声明） | assistant message → thought/message/usage updates；tool call/result → generic tool updates；turn end → 标准 StopReason；one-shot permission decisions |
| `session/prompt` 真实一轮 | ✅ 已实测（见下表） |

⚠️ **适配层结论**：**ACP 通道已实战验证可行**，是外壳适配层的推荐通道 —— 长驻 sidecar + NDJSON/stdio + 标准方法（initialize / session/new / session/prompt / session/update / session/request_permission）天然匹配本协议的传输层与事件模型。适配层校准（第 10 节落地）= 在 `dsh-process.ts` 中将 NDJSON 协议帧翻译为 ACP JSON-RPC 方法调用。`headless`（一次性、无审批）与 `web` HTTP 备选通道不再优先。

**适配层已落地（2026-09-15）**：`dsh-process.ts` 重写为 ACP 客户端（第 10 节映射表即实现），默认 profile 改 `acp`。Electron preview 冒烟实测：vendor dsh 经 ELECTRON_RUN_AS_NODE 拉起长驻、握手链全通、`engine.ready` 携带 `agent=deepseek-harness-acp@0.0.1` / `model=deepseek-v4-flash`（configOptions 提取）、无 stderr 报错、无重启循环；mock 回归（forceMock）不受影响。

#### 12.5.2 session/prompt 真实校准（2026-09-15，DEEPSEEK_API_KEY 注入实测）

| 项 | 实测结果 |
| --- | --- |
| 凭据注入 | 本机 `DEEPSEEK_API_KEY` 已在进程环境（dsh-llm-deepseek 的 `apiKeyEnv`，最高优先层）；外壳 spawn 继承 `process.env`，零改动即可用 |
| 纯文本轮 | `message.start → delta(s) → end → turn.end(done)` 全链路通；最终 `stopReason: end_turn` |
| `agent_message_chunk` / `agent_thought_chunk` | `{sessionUpdate, messageId(UUID), content: {type:'text', text}}`；thought 与 message 两流独立（可共享 messageId）；dsh-acp 为**提交后投影**（非逐 token 实时流），chunk 粒度较大 |
| `tool_call` | **无 `name` 字段**，工具名在 `title`（如 "pwsh"/"glob"）；`kind:"other"`、`status:"in_progress"`、`rawInput` 携带参数 |
| `tool_call_update`(completed) | `content` 为**嵌套形态** `[{type:'content', content:{type:'text', text}}]`（非扁平 text 块）—— `extractToolOutput` 已按此校准 |
| `usage_update` | `{used, size}`（适配层忽略） |
| `session/request_permission` | `params = {sessionId, toolCall: {toolCallId}, options: [allow_once, reject_once]}` —— **仅两个选项，无 always 系列**；toolCall 仅含 toolCallId（无 name/rawInput），适配层经 `toolCalls` 注册表回查 `tool_call` update 补全审批详情 |
| 并发 prompt | 会话进行中再发 prompt 被拒：`"a prompt is already in flight for this session"`（one-prompt admission slot）—— 外壳 UI 输入框置灰语义正确 |
| 审批往返（deny） | deny → `tool_call_update`（ok:false "the user rejected escalating…"）→ thought 反思 → 总结消息 → `turn.end(done)`；外壳 deny 经 `pickOptionId` 回退链映射到 `reject_once` |
| 工具审批触发条件 | 只读工具（glob/grep）不触发审批；写/sandbox 升级类工具（pwsh `sandbox_permissions:"danger-full-access"`）触发审批 |
| Electron CDP 全链路（渲染页 `window.dsh.*`） | 纯文本轮 / 工具轮（含超时失败）/ in-flight 错误路径（err 消息流 + 非致命 `engine.error` + `turn.end(error)`）/ 审批往返均验证通过；回归确认 `permission.request` 事件 `tool=pwsh`、input 含完整命令参数（校准前为 unknown/空） |

#### 12.5.3 会话 resume/list 接入（2026-09-16，源码实证）

dsh-acp 源码（`@deepseek-ai/dsh-acp` lib/index.js）实证的会话管理语义，接入实现据此设计：

| 项 | 实证结果 |
| --- | --- |
| `session/list` | 参数 `{cwd?, cursor?}`；cwd 必须绝对路径，按物理同目录（realpath）过滤条目；**活跃会话（本连接已 new/resume）被过滤**；subagent 派生会话（origin=subagent / 有 parentSession）不可列出；倒序分页，`nextCursor` 为 base64url 键集游标；**条目仅 `{sessionId, cwd}`**（不回传标题/时间戳） |
| `session/resume` | 参数 `{sessionId, cwd, mcpServers?}`；校验：目标未激活、持久化头存在、非 subagent/子会话、cwd 物理同目录（不符报 invalidParams）；**返回 `{configOptions}`，不回放历史**（README 明示 "resume 会重新连接 MCP 声明，但不会重放历史"） |
| `session/close` | 关闭 = 释放 Agent 实例，**非删除**；数据在持久化 JSONL 中，关闭后重新可列/可恢复 |
| 多会话共存 | bridge 的 `sessions` Map 允许多会话同时激活；重复 resume 激活中的会话报 `session is already active` |
| 外壳适配 | 引擎内维持「单活跃会话」语义：切换 = 新会话/恢复成功后 `session/close` 旧会话（失败仅 warn），旧会话随即重新出现在列表；本连接内已激活但被切走的会话（activeSessions 集合命中）直接切回，不重复 resume；prompt 在途（one-prompt slot）与审批未决时拒绝切换（非致命 `engine.error`） |
| UI | StatusBar 会话菜单：新会话 / 历史会话面板（刷新、恢复、加载更多续页）；`session.switched` 后渲染层清空时间线并提示「引擎侧保留完整上下文」；dsh 不回传标题，列表以短 UUID 展示 |
