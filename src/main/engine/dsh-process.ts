import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { KernelEvent, PermissionDecision, ShellCommand } from '../../shared/protocol'
import type { EngineExitInfo, EngineProcess } from './engine-manager'

/** dsh 捆绑来源（npm 包名，vendor 目录内解析） */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** 引擎启动方式 */
export type EngineLaunch =
  /** 捆绑运行时：复用 Electron 二进制作纯 Node（ELECTRON_RUN_AS_NODE） */
  | { kind: 'node'; entry: string }
  /** 外部命令（显式 dshPath / PATH 检测，兼容 Windows .cmd） */
  | { kind: 'command'; command: string }

/**
 * 引擎走 ACP（Agent Client Protocol，JSON-RPC 2.0 over NDJSON/stdio）。
 * dsh 的 ACP server（@deepseek-ai/dsh-acp）以 `dsh --profile acp` 长驻运行，
 * 本文件把外壳的 NDJSON 协议帧翻译为 ACP 方法调用（见 docs/protocol.md 第 10 节）。
 */
const ACP_METHOD = {
  initialize: 'initialize',
  initialized: 'initialized',
  sessionNew: 'session/new',
  sessionList: 'session/list',
  sessionResume: 'session/resume',
  sessionClose: 'session/close',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission'
} as const

/** JSON-RPC 错误载荷 */
interface RpcError {
  code: number
  message: string
  data?: unknown
}

/** ACP session/request_permission 的选项项 */
interface AcpPermissionOption {
  optionId: string
  name: string
  kind: string
}

/** ACP tool_call / tool_call_update 的公共字段（宽容解析） */
interface AcpToolCall {
  toolCallId: string
  title?: string | null
  name?: string | null
  kind?: string | null
  status?: string | null
  content?: unknown[] | null
  rawInput?: unknown
  rawOutput?: unknown
}

/** 一条流式消息的适配状态：ACP messageId ↔ 协议 messageId */
interface StreamState {
  acpMessageId: string | null
  protocolId: string | null
}

/** ACP prompt stopReason -> 协议 turn.end reason */
const TURN_REASON_FROM_ACP: Record<string, 'done' | 'interrupted' | 'error'> = {
  end_turn: 'done',
  cancelled: 'interrupted',
  max_tokens: 'error',
  max_turn_requests: 'error',
  refusal: 'error'
}

/** vendor 捆绑的 dsh 根目录：开发时在仓库 vendor/dsh，打包后随 extraResources 落在 resources/dsh */
export function bundledDshRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh')
    : path.join(app.getAppPath(), 'vendor', 'dsh')
}

/** 解析 vendor 捆绑 dsh 的 JS 入口（package.json bin 字段） */
function resolveBundledEntry(): string | null {
  const pkgDir = path.join(bundledDshRoot(), 'node_modules', DSH_PACKAGE)
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')
    ) as { bin?: string | Record<string, string> }
    const bin = pkgJson.bin
    const rel = typeof bin === 'string' ? bin : (bin?.[DSH_PACKAGE] ?? bin?.dsh)
    if (typeof rel !== 'string' || !rel) return null
    const entry = path.resolve(pkgDir, rel)
    return fs.existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

/** 探测候选外部命令是否可用 */
function probeCommand(cmd: string): boolean {
  try {
    // Windows 下 .cmd 必须经 shell 调用；参数由外壳拼接，不含用户自由文本
    const probe = spawnSync(`"${cmd}" --version`, { shell: true, timeout: 8000, encoding: 'utf-8' })
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
}

/**
 * 解析 dsh 启动方式，优先级：
 * 1. 显式 dshPath（command 模式）
 * 2. vendor 捆绑（node 模式，ELECTRON_RUN_AS_NODE）
 * 3. PATH 中的 dsh / dsh.cmd（command 模式）
 * 均不可用返回 null，调用方回退 mock。
 */
export function resolveDshLaunch(dshPath: string): EngineLaunch | null {
  if (dshPath) return probeCommand(dshPath) ? { kind: 'command', command: dshPath } : null
  const entry = resolveBundledEntry()
  if (entry) return { kind: 'node', entry }
  for (const cmd of ['dsh', 'dsh.cmd']) {
    if (probeCommand(cmd)) return { kind: 'command', command: cmd }
  }
  return null
}

/** 提取 ACP ContentBlock 中的文本（非 text 块返回空串） */
function extractText(content: unknown): string {
  if (content && typeof content === 'object' && (content as { type?: unknown }).type === 'text') {
    const text = (content as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}

/**
 * 提取工具调用的输出文本（content 数组拼接，回退 rawOutput）。
 * 实测块形态（见 protocol.md 12.5.1）：嵌套 content 块 `{type:'content', content:{type:'text',…}}`；
 * 平面 text 块与其他类型（diff / terminal 等）作兼容回退。
 */
function extractToolOutput(tc: AcpToolCall): string {
  if (Array.isArray(tc.content)) {
    const parts: string[] = []
    for (const item of tc.content) {
      if (item && typeof item === 'object') {
        const block = item as { type?: unknown; content?: unknown; text?: unknown }
        if (block.type === 'text') {
          if (typeof block.text === 'string') parts.push(block.text)
        } else if (block.type === 'content') {
          const text = extractText(block.content)
          parts.push(text || JSON.stringify(block.content))
        } else {
          parts.push(JSON.stringify(item))
        }
      }
    }
    if (parts.length) return parts.join('\n')
  }
  if (tc.rawOutput !== undefined && tc.rawOutput !== null) {
    return typeof tc.rawOutput === 'string' ? tc.rawOutput : JSON.stringify(tc.rawOutput)
  }
  return ''
}

/**
 * 外壳审批决策 -> ACP 选项 id（找不到匹配选项返回 null，等效取消）。
 * 实测 dsh-acp 仅提供 allow_once / reject_once（无 always 系列），
 * allow_always 按回退链降级为 allow_once。
 */
const PERMISSION_KIND_FALLBACK: Record<PermissionDecision, readonly string[]> = {
  allow_once: ['allow_once'],
  allow_always: ['allow_always', 'allow_once'],
  deny: ['reject_once', 'reject_always']
}

function pickOptionId(options: AcpPermissionOption[], decision: PermissionDecision): string | null {
  for (const kind of PERMISSION_KIND_FALLBACK[decision]) {
    const hit = options.find((o) => o.kind === kind)
    if (hit) return hit.optionId
  }
  return null
}

/** 从 session/new 的 configOptions 提取当前模型名（宽容解析，失败返回 null） */
function extractCurrentModel(configOptions: unknown): string | null {
  if (!Array.isArray(configOptions)) return null
  const opt = configOptions.find(
    (o) => o && typeof o === 'object' && (o as { id?: unknown }).id === 'model'
  ) as { currentValue?: unknown } | undefined
  try {
    const parsed =
      typeof opt?.currentValue === 'string' ? JSON.parse(opt.currentValue) : opt?.currentValue
    if (Array.isArray(parsed) && typeof parsed[1] === 'string') return parsed[1]
  } catch {
    // currentValue 非法 JSON：忽略
  }
  return null
}

/** 以 ACP 客户端方式运行 dsh sidecar，NDJSON/stdio 上收发 JSON-RPC */
export class DshProcess implements EngineProcess {
  readonly mode = 'dsh' as const
  private child: ChildProcess | null = null
  private listener: ((event: KernelEvent) => void) | null = null
  private exitListener: ((info: EngineExitInfo) => void) | null = null
  private activityListener: (() => void) | null = null
  private buffer = ''
  private disposed = false

  private sessionId: string | null = null
  /** 本连接内已激活的会话（新建/恢复过）：切换走时不关闭则无法再从 session/list 看见 */
  private activeSessions = new Set<string>()
  /** session/prompt 是否在途（one-prompt admission slot 期间禁止切换会话） */
  private promptInFlight = false
  private nextRpcId = 1
  private rpcHandlers = new Map<number, (result: unknown, error: RpcError | null) => void>()
  private permissionPending: { rpcId: number; options: AcpPermissionOption[] } | null = null
  /** callId -> 工具调用摘要；request_permission 的 toolCall 仅含 toolCallId，回查补全审批详情 */
  private toolCalls = new Map<string, { tool: string; input: unknown }>()
  private agentName = 'dsh-acp'
  private agentVersion: string | undefined
  private thoughtStream: StreamState = { acpMessageId: null, protocolId: null }
  private messageStream: StreamState = { acpMessageId: null, protocolId: null }
  private nextThoughtSeq = 0
  private nextMsgSeq = 0

  constructor(
    private readonly launch: EngineLaunch,
    private readonly profile: string,
    private readonly cwd: string
  ) {}

  onEvent(cb: (event: KernelEvent) => void): void {
    this.listener = cb
  }

  onExit(cb: (info: EngineExitInfo) => void): void {
    this.exitListener = cb
  }

  onActivity(cb: () => void): void {
    this.activityListener = cb
  }

  private emit(event: KernelEvent): void {
    if (!this.disposed) this.listener?.(event)
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        let child: ChildProcess
        if (this.launch.kind === 'node') {
          // 捆绑运行时：Electron 二进制 + ELECTRON_RUN_AS_NODE 作纯 Node，
          // 参数数组传递，不经 shell，无注入面
          child = spawn(process.execPath, [this.launch.entry, '--profile', this.profile], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        } else {
          // 外部命令：参数由外壳拼接（不含用户自由文本），经 shell 以兼容 Windows .cmd
          const cmdline = `"${this.launch.command}" --profile ${this.profile}`
          child = spawn(cmdline, {
            shell: true,
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        }
        this.child = child

        child.stdout?.setEncoding('utf-8')
        child.stdout?.on('data', (chunk: string) => {
          this.activityListener?.()
          this.onStdout(chunk)
        })
        child.stderr?.setEncoding('utf-8')
        child.stderr?.on('data', (chunk: string) => {
          this.activityListener?.()
          // 引擎日志走 stderr，不进入消息流
          console.warn('[dsh]', chunk.trimEnd())
        })
        child.on('error', (err) => reject(err))
        child.on('exit', (code, signal) => {
          if (this.disposed) return
          // 退出处理（自动重启决策）交由 DshEngineManager
          this.exitListener?.({ code, signal: signal ?? undefined })
        })

        // ACP 握手：initialize -> (result) -> initialized + session/new -> engine.ready
        this.sendRpc(
          ACP_METHOD.initialize,
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
          },
          (result, error) => this.onInitializeResult(result, error)
        )

        resolve()
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  send(cmd: ShellCommand): void {
    switch (cmd.type) {
      case 'user.input':
        if (!this.sessionId) {
          this.emit({ type: 'engine.error', message: '引擎尚未完成 ACP 握手，无法发送输入', fatal: false })
          return
        }
        this.promptInFlight = true
        this.sendRpc(
          ACP_METHOD.sessionPrompt,
          { sessionId: this.sessionId, prompt: [{ type: 'text', text: cmd.text }] },
          (result, error) => this.onPromptResult(result, error)
        )
        break
      case 'session.list':
        this.sendRpc(
          ACP_METHOD.sessionList,
          { cwd: this.cwd, ...(cmd.cursor ? { cursor: cmd.cursor } : {}) },
          (result, error) => this.onSessionListResult(result, error, cmd.cursor)
        )
        break
      case 'session.new':
        if (!this.canSwitchSession()) return
        this.sendRpc(ACP_METHOD.sessionNew, { cwd: this.cwd, mcpServers: [] }, (result, error) => {
          const sessionId = (result as { sessionId?: unknown } | null)?.sessionId
          if (error || typeof sessionId !== 'string' || !sessionId) {
            this.emit({
              type: 'engine.error',
              message: `新建会话失败: ${error?.message ?? '无 sessionId'}`,
              fatal: false
            })
            return
          }
          const model = extractCurrentModel((result as { configOptions?: unknown }).configOptions)
          this.activeSessions.add(sessionId)
          this.closeCurrentSession()
          this.switchToSession(sessionId, 'new', model)
        })
        break
      case 'session.resume': {
        if (!this.canSwitchSession()) return
        const target = cmd.sessionId
        if (!target || target === this.sessionId) return
        if (this.activeSessions.has(target)) {
          // 本连接内已激活（先前切换走但未关闭）：直接切回，session/resume 会拒绝重复激活
          this.switchToSession(target, 'resumed')
          return
        }
        this.sendRpc(
          ACP_METHOD.sessionResume,
          { sessionId: target, cwd: this.cwd, mcpServers: [] },
          (result, error) => {
            if (error) {
              this.emit({
                type: 'engine.error',
                message: `恢复会话失败: ${error.message}`,
                fatal: false
              })
              return
            }
            const model = extractCurrentModel((result as { configOptions?: unknown }).configOptions)
            // 恢复成功后再关闭旧会话，失败则留在当前会话
            this.activeSessions.add(target)
            this.closeCurrentSession()
            this.switchToSession(target, 'resumed', model)
          }
        )
        break
      }
      case 'permission.response': {
        const pending = this.permissionPending
        if (!pending) {
          console.warn('[dsh-acp] 无待响应的审批请求，忽略 permission.response')
          return
        }
        this.permissionPending = null
        const optionId = pickOptionId(pending.options, cmd.decision)
        // 无匹配选项时以错误响应（agent 按 cancelled 处理）
        this.write(
          optionId !== null
            ? { jsonrpc: '2.0', id: pending.rpcId, result: { outcome: { outcome: 'selected', optionId } } }
            : { jsonrpc: '2.0', id: pending.rpcId, error: { code: -32000, message: '用户取消' } }
        )
        break
      }
      case 'interrupt':
        if (!this.sessionId) return
        this.write({ jsonrpc: '2.0', method: ACP_METHOD.sessionCancel, params: { sessionId: this.sessionId } })
        break
    }
  }

  kill(): void {
    this.disposed = true
    // ACP server 在 stdin EOF 时优雅退出
    try {
      this.child?.stdin?.end()
    } catch {
      // 忽略
    }
    this.child?.kill()
  }

  // ---- JSON-RPC 收发 ----

  private write(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin
    if (!stdin || !stdin.writable) {
      this.emit({ type: 'engine.error', message: '引擎进程不可用', fatal: false })
      return
    }
    stdin.write(JSON.stringify(msg) + '\n')
  }

  private sendRpc(
    method: string,
    params: unknown,
    onResult: (result: unknown, error: RpcError | null) => void
  ): void {
    const id = this.nextRpcId++
    this.rpcHandlers.set(id, onResult)
    this.write({ jsonrpc: '2.0', id, method, params })
  }

  /** stdout 行缓冲：按行解析 JSON-RPC 消息 */
  private onStdout(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg && typeof msg === 'object') {
          this.dispatch(msg as Record<string, unknown>)
        }
      } catch {
        console.warn('[dsh-acp] 无法解析引擎输出行:', line.slice(0, 200))
      }
    }
  }

  /** 按 JSON-RPC 消息形态分发：外壳请求的响应 / agent 请求 / agent 通知 */
  private dispatch(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : null
    const method = typeof msg.method === 'string' ? msg.method : null

    if (method && id !== null) {
      this.handleAgentRequest(id, method, msg.params)
    } else if (method) {
      this.handleNotification(method, msg.params)
    } else if (id !== null) {
      const handler = this.rpcHandlers.get(id)
      if (!handler) {
        console.warn('[dsh-acp] 收到未关联的 RPC 响应:', JSON.stringify(msg).slice(0, 200))
        return
      }
      this.rpcHandlers.delete(id)
      handler(msg.result ?? null, (msg.error as RpcError) ?? null)
    } else {
      console.warn('[dsh-acp] 忽略无法归类的 JSON-RPC 消息:', JSON.stringify(msg).slice(0, 200))
    }
  }

  // ---- 握手链 ----

  private onInitializeResult(result: unknown, error: RpcError | null): void {
    if (error || !result) {
      this.emit({
        type: 'engine.error',
        message: `ACP initialize 失败: ${error?.message ?? '空响应'}`,
        fatal: true
      })
      return
    }
    const info = result as { agentInfo?: { name?: string; version?: string } }
    if (typeof info.agentInfo?.name === 'string') this.agentName = info.agentInfo.name
    if (typeof info.agentInfo?.version === 'string') this.agentVersion = info.agentInfo.version
    this.write({ jsonrpc: '2.0', method: ACP_METHOD.initialized })
    this.sendRpc(
      ACP_METHOD.sessionNew,
      { cwd: this.cwd, mcpServers: [] },
      (r, e) => this.onSessionNewResult(r, e)
    )
  }

  private onSessionNewResult(result: unknown, error: RpcError | null): void {
    const sessionId = (result as { sessionId?: unknown } | null)?.sessionId
    if (error || typeof sessionId !== 'string' || !sessionId) {
      this.emit({
        type: 'engine.error',
        message: `ACP session/new 失败: ${error?.message ?? '无 sessionId'}`,
        fatal: true
      })
      return
    }
    this.sessionId = sessionId
    this.activeSessions.add(sessionId)
    const model = extractCurrentModel((result as { configOptions?: unknown }).configOptions)
    console.log(
      `[dsh-acp] 握手完成: agent=${this.agentName}${this.agentVersion ? '@' + this.agentVersion : ''}` +
        ` session=${sessionId.slice(0, 8)}…${model ? ` model=${model}` : ''}`
    )
    this.emit({
      type: 'engine.ready',
      engine: 'dsh',
      agent: this.agentName,
      version: this.agentVersion,
      sessionId,
      ...(model ? { model } : {})
    })
  }

  private onPromptResult(result: unknown, error: RpcError | null): void {
    this.promptInFlight = false
    this.closeStreams()
    if (error) {
      const errId = `err_${Date.now()}`
      this.emit({ type: 'message.start', messageId: errId })
      this.emit({
        type: 'message.delta',
        messageId: errId,
        text: `[引擎错误] ACP session/prompt 失败：${error.message}`
      })
      this.emit({ type: 'message.end', messageId: errId })
      this.emit({ type: 'engine.error', message: `session/prompt 失败: ${error.message}`, fatal: false })
      this.emit({ type: 'turn.end', reason: 'error' })
      return
    }
    const stop = (result as { stopReason?: unknown } | null)?.stopReason
    const reason =
      typeof stop === 'string' && TURN_REASON_FROM_ACP[stop] ? TURN_REASON_FROM_ACP[stop] : 'done'
    this.emit({ type: 'turn.end', reason })
  }

  // ---- 会话管理（list / new / resume / close） ----

  /** session/list 结果 -> session.list 事件（宽容解析条目） */
  private onSessionListResult(result: unknown, error: RpcError | null, cursor?: string): void {
    if (error) {
      this.emit({
        type: 'engine.error',
        message: `获取会话列表失败: ${error.message}`,
        fatal: false
      })
      return
    }
    const res = (result ?? {}) as { sessions?: unknown; nextCursor?: unknown }
    const sessions = Array.isArray(res.sessions)
      ? res.sessions
          .map((it) => (it ?? {}) as { sessionId?: unknown; cwd?: unknown })
          .filter((it) => typeof it.sessionId === 'string' && typeof it.cwd === 'string')
          .map((it) => ({ sessionId: it.sessionId as string, cwd: it.cwd as string }))
      : []
    this.emit({
      type: 'session.list',
      sessions,
      ...(cursor ? { cursor } : {}),
      ...(typeof res.nextCursor === 'string' ? { nextCursor: res.nextCursor } : {})
    })
  }

  /** 切换会话的前置守卫：prompt 在途或审批未决时拒绝（当前会话的一轮必须完整收尾） */
  private canSwitchSession(): boolean {
    if (this.promptInFlight) {
      this.emit({
        type: 'engine.error',
        message: '当前轮次尚未结束，无法切换会话',
        fatal: false
      })
      return false
    }
    if (this.permissionPending) {
      this.emit({
        type: 'engine.error',
        message: '有待处理的审批请求，请先处理后再切换会话',
        fatal: false
      })
      return false
    }
    return true
  }

  /** 关闭当前会话（数据已持久化，关闭后重新出现在 session/list 中可再次恢复） */
  private closeCurrentSession(): void {
    const old = this.sessionId
    if (!old) return
    this.activeSessions.delete(old)
    this.sendRpc(ACP_METHOD.sessionClose, { sessionId: old }, (_r, e) => {
      if (e) console.warn(`[dsh-acp] 关闭旧会话失败（不影响使用）: ${e.message}`)
    })
  }

  /** 切换当前会话：收尾旧消息流、清理旧会话的审批辅助状态，广播 session.switched */
  private switchToSession(sessionId: string, kind: 'new' | 'resumed', model?: string | null): void {
    this.closeStreams()
    this.toolCalls.clear()
    this.sessionId = sessionId
    this.emit({
      type: 'session.switched',
      sessionId,
      kind,
      ...(model ? { model } : {})
    })
  }

  // ---- agent -> 外壳 ----

  /** 处理引擎发起的 JSON-RPC 请求（当前仅 session/request_permission） */
  private handleAgentRequest(id: number, method: string, params: unknown): void {
    if (method !== ACP_METHOD.requestPermission) {
      // 未知方法回 method-not-found，避免引擎侧挂起等待
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }
    const raw = (params ?? {}) as { toolCall?: AcpToolCall; options?: AcpPermissionOption[] }
    const toolCall = raw.toolCall ?? ({} as AcpToolCall)
    const options = Array.isArray(raw.options) ? raw.options : []
    // dsh-acp 实测：request_permission 的 toolCall 仅含 toolCallId（无 name/rawInput），
    // 回查 tool_call update 时记录的摘要补全审批详情
    const known =
      typeof toolCall.toolCallId === 'string' ? this.toolCalls.get(toolCall.toolCallId) : undefined
    this.permissionPending = { rpcId: id, options }
    this.emit({
      type: 'permission.request',
      requestId: `perm_${id}`,
      callId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
      tool: known?.tool ?? toolCall.name ?? toolCall.title ?? 'unknown',
      input: known?.input ?? toolCall.rawInput ?? {},
      reason: toolCall.title ?? undefined
    })
  }

  /** 处理引擎通知（当前仅 session/update） */
  private handleNotification(method: string, params: unknown): void {
    if (method !== ACP_METHOD.sessionUpdate) {
      console.warn('[dsh-acp] 忽略引擎通知:', method)
      return
    }
    const update = (params as { update?: Record<string, unknown> } | null)?.update
    if (!update || typeof update.sessionUpdate !== 'string') {
      console.warn('[dsh-acp] session/update 缺少 update 字段')
      return
    }
    this.applySessionUpdate(update)
  }

  /** ACP session/update -> 协议事件（未知 update 类型忽略，保证向前兼容） */
  private applySessionUpdate(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = extractText(update.content)
        const acpMessageId = typeof update.messageId === 'string' ? update.messageId : null
        this.appendChunk(update.sessionUpdate === 'agent_thought_chunk', acpMessageId, text)
        break
      }
      case 'tool_call': {
        const tc = update as unknown as AcpToolCall
        if (typeof tc.toolCallId !== 'string') return
        const tool = tc.name ?? tc.title ?? 'unknown'
        const input = tc.rawInput ?? {}
        // 记录工具调用摘要：request_permission 的 toolCall 仅含 toolCallId，回查补全审批详情
        this.toolCalls.set(tc.toolCallId, { tool, input })
        // 工具调用前收尾打开的消息流（协议时序：message.end(tool_use) -> tool.call）
        this.closeStreams('tool_use')
        this.emit({
          type: 'tool.call',
          callId: tc.toolCallId,
          tool,
          input
        })
        break
      }
      case 'tool_call_update': {
        const tc = update as unknown as AcpToolCall
        if (tc.status === 'completed' || tc.status === 'failed') {
          this.emit({
            type: 'tool.result',
            callId: tc.toolCallId,
            ok: tc.status === 'completed',
            output: extractToolOutput(tc)
          })
        }
        break
      }
      default:
        // plan / usage / compaction / available_commands 等：暂不映射
        console.warn('[dsh-acp] 忽略 session/update:', update.sessionUpdate)
    }
  }

  // ---- 消息流适配 ----

  /** 追加流式 chunk：messageId 变化即新消息（先收尾旧流再开新流） */
  private appendChunk(isThought: boolean, acpMessageId: string | null, text: string): void {
    const stream = isThought ? this.thoughtStream : this.messageStream
    if (stream.protocolId === null || (acpMessageId !== null && acpMessageId !== stream.acpMessageId)) {
      if (stream.protocolId !== null) {
        this.emit({ type: 'message.end', messageId: stream.protocolId })
      }
      const protocolId = isThought ? `thought_${++this.nextThoughtSeq}` : `msg_${++this.nextMsgSeq}`
      stream.acpMessageId = acpMessageId
      stream.protocolId = protocolId
      this.emit({ type: 'message.start', messageId: protocolId })
    }
    if (text) this.emit({ type: 'message.delta', messageId: stream.protocolId, text })
  }

  /** 收尾打开的消息流（thought 与 message 各至多一条） */
  private closeStreams(stopReason?: 'tool_use'): void {
    for (const stream of [this.thoughtStream, this.messageStream]) {
      if (stream.protocolId !== null) {
        this.emit({
          type: 'message.end',
          messageId: stream.protocolId,
          ...(stopReason ? { stopReason } : {})
        })
        stream.acpMessageId = null
        stream.protocolId = null
      }
    }
  }
}
