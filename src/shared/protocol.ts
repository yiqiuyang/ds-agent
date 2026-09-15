/**
 * 外壳 <-> 内核事件协议（NDJSON over stdio）
 *
 * 规范文档：docs/protocol.md
 * 设计原则：
 * - 外壳不依赖引擎内部实现，仅通过本协议通信
 * - dsh 处于 developer preview，原生事件 schema 未冻结；
 *   引擎差异统一收敛在 main/engine/dsh-process.ts 的适配层
 * - 双向均为「一行一个 JSON」，事件采用点分命名 <对象>.<动作>
 */

// ========== 内核 -> 外壳（事件） ==========

export interface EngineReadyEvent {
  type: 'engine.ready'
  /** 引擎种类 */
  engine: 'dsh' | 'mock'
  /** 引擎标识，如 'dsh' / 'mock-engine' */
  agent: string
  version?: string
  model?: string
}

export interface MessageStartEvent {
  type: 'message.start'
  messageId: string
}

export interface MessageDeltaEvent {
  type: 'message.delta'
  messageId: string
  /** 增量文本 */
  text: string
}

export type MessageStopReason = 'stop' | 'tool_use' | 'interrupted' | 'error'

export interface MessageEndEvent {
  type: 'message.end'
  messageId: string
  stopReason?: MessageStopReason
}

export interface ToolCallEvent {
  type: 'tool.call'
  callId: string
  tool: string
  input: unknown
}

export interface ToolResultEvent {
  type: 'tool.result'
  callId: string
  ok: boolean
  output: string
}

export interface PermissionRequestEvent {
  type: 'permission.request'
  requestId: string
  /** 关联的工具调用（可选） */
  callId?: string
  tool: string
  input: unknown
  /** 引擎给出的说明 */
  reason?: string
}

export interface TurnEndEvent {
  type: 'turn.end'
  reason: 'done' | 'interrupted' | 'error'
}

export interface EngineErrorEvent {
  type: 'engine.error'
  message: string
  /** 致命错误：引擎不可用，需要重启 */
  fatal?: boolean
}

export interface EngineExitedEvent {
  type: 'engine.exited'
  code: number | null
  signal?: string
}

/** 主进程 DshEngineManager 主动上报的生命周期状态变更 */
export interface EngineStatusEvent {
  type: 'engine.status'
  status: EngineStatus
  /** 状态说明（如自动重启原因） */
  message?: string
}

export type KernelEvent =
  | EngineReadyEvent
  | EngineStatusEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | TurnEndEvent
  | EngineErrorEvent
  | EngineExitedEvent

// ========== 外壳 -> 内核（命令） ==========

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'

export type ShellCommand =
  | { type: 'user.input'; text: string }
  | { type: 'permission.response'; requestId: string; decision: PermissionDecision }
  | { type: 'interrupt' }

// ========== 状态与配置 ==========

export type EngineStatus =
  | 'starting'
  | 'ready'
  | 'busy'
  | 'waiting_permission'
  | 'restarting'
  | 'exited'
  | 'error'

export interface ShellConfig {
  /** dsh 可执行文件路径；空 = 自动检测 PATH */
  dshPath: string
  /** dsh profile，默认 acp */
  profile: string
  /** 工作区目录；空 = 用户主目录 */
  workspaceDir: string
  /** 强制使用 mock 引擎 */
  forceMock: boolean
}
