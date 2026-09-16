import type { KernelEvent, PermissionDecision, ShellCommand } from '../../shared/protocol'
import type { EngineExitInfo, EngineProcess } from './engine-manager'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface PendingPermission {
  requestId: string
  tool: string
  resolve: (decision: PermissionDecision) => void
}

/**
 * 确定性 mock 引擎：本机无 dsh 时驱动完整 UI 流程
 * （流式输出 -> 工具调用 -> 审批弹窗 -> 工具结果 -> 收尾）
 */
export class MockEngine implements EngineProcess {
  readonly mode = 'mock' as const
  private listener: ((event: KernelEvent) => void) | null = null
  private cancelled = false
  private disposed = false
  private busy = false
  private msgSeq = 0
  private callSeq = 0
  private sessionSeq = 1
  private sessionId = 'mock-sess-1'
  /** mock 历史会话池（不含当前会话；供恢复演示） */
  private readonly historyPool = ['mock-hist-1', 'mock-hist-2', 'mock-hist-3']
  private allowedTools = new Set<string>()
  private pending: PendingPermission | null = null

  onEvent(cb: (event: KernelEvent) => void): void {
    this.listener = cb
  }

  /** mock 不会退出，永不触发 onExit */
  onExit(_cb: (info: EngineExitInfo) => void): void {
    // 故意为空
  }

  /** mock 同步发 ready，无需活动信号维持看门狗 */
  onActivity(_cb: () => void): void {
    // 故意为空
  }

  private emit(event: KernelEvent): void {
    if (!this.disposed) this.listener?.(event)
  }

  async start(): Promise<void> {
    await sleep(200)
    this.emit({
      type: 'engine.ready',
      engine: 'mock',
      agent: 'mock-engine',
      version: '0.1.0',
      model: 'deepseek-v4-pro (mock)',
      sessionId: this.sessionId
    })
  }

  send(cmd: ShellCommand): void {
    switch (cmd.type) {
      case 'interrupt':
        this.cancelled = true
        this.pending?.resolve('deny')
        break
      case 'permission.response': {
        const pending = this.pending
        if (pending && pending.requestId === cmd.requestId) {
          this.pending = null
          if (cmd.decision === 'allow_always') this.allowedTools.add(pending.tool)
          pending.resolve(cmd.decision)
        }
        break
      }
      case 'user.input':
        void this.runTurn(cmd.text)
        break
      case 'session.list':
        this.emit({
          type: 'session.list',
          sessions: this.historyPool
            .filter((id) => id !== this.sessionId)
            .map((sessionId) => ({ sessionId, cwd: 'mock://workspace' }))
        })
        break
      case 'session.new':
        if (!this.canSwitchSession()) return
        this.sessionId = `mock-sess-${++this.sessionSeq}`
        this.emit({
          type: 'session.switched',
          sessionId: this.sessionId,
          kind: 'new',
          model: 'deepseek-v4-pro (mock)'
        })
        break
      case 'session.resume':
        if (!this.canSwitchSession()) return
        if (!cmd.sessionId || cmd.sessionId === this.sessionId) return
        this.sessionId = cmd.sessionId
        this.emit({
          type: 'session.switched',
          sessionId: this.sessionId,
          kind: 'resumed',
          model: 'deepseek-v4-pro (mock)'
        })
        break
    }
  }

  /** 切换会话的前置守卫（与 DshProcess 语义一致） */
  private canSwitchSession(): boolean {
    if (this.busy) {
      this.emit({ type: 'engine.error', message: '当前轮次尚未结束，无法切换会话', fatal: false })
      return false
    }
    if (this.pending) {
      this.emit({
        type: 'engine.error',
        message: '有待处理的审批请求，请先处理后再切换会话',
        fatal: false
      })
      return false
    }
    return true
  }

  kill(): void {
    this.cancelled = true
    this.disposed = true
    this.pending?.resolve('deny')
  }

  /** 模拟一轮完整交互：流式回复 + 工具调用 + 审批 + 结果 */
  private async runTurn(text: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.cancelled = false
    try {
      const greeting = /^(你好|您好|hi|hello|嗨)/i.test(text.trim())
      if (greeting) {
        await this.streamMessage(
          '你好！我是 **mock 引擎**，在外壳无 dsh 时演示完整交互流程。\n\n' +
            '当前演示能力：\n\n' +
            '1. 流式回复\n2. 工具调用卡片\n3. 审批弹窗\n4. 中断\n\n' +
            '安装 dsh 后，在「设置」中配置路径即可切换到真实引擎。'
        )
        return
      }

      await this.streamMessage(
        `收到任务：\n\n> ${text.slice(0, 200)}\n\n` +
          '我先梳理执行计划：\n\n' +
          '1. 分析任务诉求\n2. 调用工具完成操作\n3. 汇报结果\n\n' +
          '下面演示一次工具调用与审批流程：'
      )
      if (this.cancelled) return

      const callId = `call_${++this.callSeq}`
      const tool = 'write_file'
      const input = {
        path: 'demo/hello.md',
        content: '# ds-agent\n\n这是 mock 引擎写入的演示文件。\n'
      }
      this.emit({ type: 'tool.call', callId, tool, input })

      let decision: PermissionDecision
      if (this.allowedTools.has(tool)) {
        decision = 'allow_once' // 已获常驻授权，直接放行
      } else {
        decision = await this.requestPermission(
          `req_${Date.now()}`,
          tool,
          input,
          'mock 引擎请求写入文件，用于演示审批流程'
        )
      }
      if (this.cancelled) {
        this.emit({ type: 'tool.result', callId, ok: false, output: '已中断' })
        return
      }

      if (decision === 'deny') {
        this.emit({ type: 'tool.result', callId, ok: false, output: '用户拒绝了该操作' })
        await this.streamMessage('已按你的要求取消了文件写入。')
      } else {
        await sleep(400)
        this.emit({
          type: 'tool.result',
          callId,
          ok: true,
          output: `已写入 demo/hello.md（${input.content.length} 字节）`
        })
        await this.streamMessage(
          '文件写入完成。\n\n' +
            '**执行总结**\n\n' +
            '| 步骤 | 结果 |\n| --- | --- |\n| 分析任务 | 完成 |\n| 写入文件 | 完成 |\n\n' +
            '```\nmock 引擎不支持真实文件操作；\n接入 dsh 后，此处为真实工具结果。\n```'
        )
      }
    } finally {
      this.busy = false
      this.emit({ type: 'turn.end', reason: this.cancelled ? 'interrupted' : 'done' })
    }
  }

  private requestPermission(
    requestId: string,
    tool: string,
    input: unknown,
    reason: string
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.pending = { requestId, tool, resolve }
      this.emit({ type: 'permission.request', requestId, tool, input, reason })
    })
  }

  /** 按小片段流式输出，模拟打字机效果 */
  private async streamMessage(text: string): Promise<void> {
    const messageId = `msg_${++this.msgSeq}`
    this.emit({ type: 'message.start', messageId })
    for (let i = 0; i < text.length; i += 3) {
      if (this.cancelled) break
      this.emit({ type: 'message.delta', messageId, text: text.slice(i, i + 3) })
      await sleep(15)
    }
    this.emit({ type: 'message.end', messageId, stopReason: 'stop' })
  }
}
