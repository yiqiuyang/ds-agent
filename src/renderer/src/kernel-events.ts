import type { KernelEvent } from '../../shared/protocol'
import { useShell } from './store'

/**
 * 全局事件订阅器：把内核 NDJSON 事件映射为 UI 状态。
 *
 * - engine.ready      -> 开启新会话（重置时间线、引擎信息）
 * - message.delta     -> 追加流式文本
 * - tool.call/result  -> 工具卡片状态流转
 * - permission.request -> 弹出审批弹窗（pendingPermission）
 * - turn.end          -> 回到就绪，未决审批按拒绝结算
 * - engine.status     -> 生命周期状态（starting / restarting 等）
 *
 * App 挂载时调用一次 subscribeKernelEvents()，返回取消订阅函数。
 */
export function subscribeKernelEvents(): () => void {
  return window.dsh.onEvent(applyKernelEvent)
}

function applyKernelEvent(event: KernelEvent): void {
  switch (event.type) {
    case 'engine.ready':
      useShell.setState({
        status: 'ready',
        engine: { mode: event.engine, agent: event.agent, model: event.model },
        sessionId: event.sessionId ?? null,
        timeline: [],
        streamingMessageId: null,
        pendingPermission: null
      })
      break

    case 'session.list':
      useShell.setState((s) => ({
        sessionList: {
          // 续页请求（带 cursor）追加到已加载条目之后；首页请求整体替换
          sessions: event.cursor
            ? [...(s.sessionList?.sessions ?? []), ...event.sessions]
            : event.sessions,
          nextCursor: event.nextCursor ?? null,
          loading: false
        }
      }))
      break

    case 'session.switched':
      // ACP resume 不回放历史：清空时间线，以系统提示说明上下文仍在引擎侧
      useShell.setState((s) => ({
        status: 'ready',
        sessionId: event.sessionId,
        ...(event.model ? { engine: s.engine ? { ...s.engine, model: event.model } : null } : {}),
        timeline: [
          {
            kind: 'message',
            id: `sys_${Date.now()}`,
            role: 'assistant',
            text:
              event.kind === 'new'
                ? '已开始新会话。'
                : `已恢复会话 \`${event.sessionId.slice(0, 8)}…\`。引擎侧保留完整上下文，可直接继续对话。`
          }
        ],
        streamingMessageId: null,
        pendingPermission: null,
        sessionList: null
      }))
      break

    case 'engine.status':
      useShell.setState({ status: event.status })
      break

    case 'message.start':
      useShell.setState((s) => ({
        status: 'busy',
        timeline: [
          ...s.timeline,
          { kind: 'message', id: event.messageId, role: 'assistant', text: '' }
        ],
        streamingMessageId: event.messageId
      }))
      break

    case 'message.delta':
      useShell.setState((s) => ({
        timeline: s.timeline.map((item) =>
          item.kind === 'message' && item.id === event.messageId
            ? { ...item, text: item.text + event.text }
            : item
        )
      }))
      break

    case 'message.end':
      useShell.setState({ streamingMessageId: null })
      break

    case 'tool.call':
      useShell.setState((s) => ({
        timeline: [
          ...s.timeline,
          {
            kind: 'tool',
            callId: event.callId,
            tool: event.tool,
            input: event.input,
            status: 'running'
          }
        ]
      }))
      break

    case 'tool.result':
      useShell.setState((s) => ({
        timeline: s.timeline.map((item) =>
          item.kind === 'tool' && item.callId === event.callId
            ? { ...item, status: event.ok ? 'ok' : 'error', output: event.output }
            : item
        )
      }))
      break

    case 'permission.request':
      useShell.setState((s) => ({
        status: 'waiting_permission',
        pendingPermission: {
          requestId: event.requestId,
          callId: event.callId,
          tool: event.tool,
          input: event.input,
          reason: event.reason
        },
        timeline: [
          ...s.timeline,
          {
            kind: 'approval',
            requestId: event.requestId,
            callId: event.callId,
            tool: event.tool,
            input: event.input,
            reason: event.reason
          }
        ]
      }))
      break

    case 'turn.end':
      useShell.setState((s) => ({
        status: 'ready',
        streamingMessageId: null,
        pendingPermission: null,
        // 中断等场景下审批可能未处理，按拒绝结算
        timeline: s.timeline.map((item) =>
          item.kind === 'approval' && !item.resolved ? { ...item, resolved: 'deny' as const } : item
        )
      }))
      break

    case 'engine.error':
      if (event.fatal) {
        useShell.setState((s) => ({
          status: 'error',
          streamingMessageId: null,
          pendingPermission: null,
          timeline: [
            ...s.timeline,
            {
              kind: 'message',
              id: `err_${Date.now()}`,
              role: 'assistant',
              text: `[引擎错误] ${event.message}\n\n可通过右上角「重启引擎」恢复。`
            }
          ]
        }))
      }
      break

    case 'engine.exited':
      // 崩溃自动重启时，随后的 engine.status(restarting) 会覆盖该状态
      useShell.setState((s) => ({
        status: s.status === 'restarting' ? s.status : 'exited',
        pendingPermission: null
      }))
      break
  }
}
