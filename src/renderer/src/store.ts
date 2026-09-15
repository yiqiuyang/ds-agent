import { create } from 'zustand'
import type { EngineStatus, PermissionDecision } from '../../shared/protocol'

export interface EngineInfo {
  mode: 'dsh' | 'mock'
  agent: string
  model?: string
}

export type TimelineItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string }
  | {
      kind: 'tool'
      callId: string
      tool: string
      input: unknown
      status: 'running' | 'ok' | 'error' | 'denied'
      output?: string
    }
  | {
      kind: 'approval'
      requestId: string
      callId?: string
      tool: string
      input: unknown
      reason?: string
      resolved?: PermissionDecision
    }

/** permission.request 弹窗的未决审批 */
export interface PermissionPrompt {
  requestId: string
  callId?: string
  tool: string
  input: unknown
  reason?: string
}

export type View = 'chat' | 'bundles'

/**
 * 渲染层全局状态。事件 -> 状态的映射在 kernel-events.ts（全局事件订阅器），
 * 本 store 只承载状态与 UI 直接调用的动作。
 */
interface ShellState {
  status: EngineStatus
  engine: EngineInfo | null
  timeline: TimelineItem[]
  streamingMessageId: string | null
  pendingPermission: PermissionPrompt | null
  view: View

  setView: (view: View) => void
  appendUserMessage: (text: string) => void
  respondPermission: (requestId: string, decision: PermissionDecision) => void
}

export const useShell = create<ShellState>((set) => ({
  status: 'starting',
  engine: null,
  timeline: [],
  streamingMessageId: null,
  pendingPermission: null,
  view: 'chat',

  setView: (view) => set({ view }),

  appendUserMessage: (text) => {
    set((s) => ({
      status: 'busy',
      timeline: [...s.timeline, { kind: 'message', id: `user_${Date.now()}`, role: 'user', text }]
    }))
  },

  respondPermission: (requestId, decision) => {
    set((s) => ({
      status: 'busy',
      pendingPermission: null,
      timeline: s.timeline.map((item) =>
        item.kind === 'approval' && item.requestId === requestId
          ? { ...item, resolved: decision }
          : item
      )
    }))
    void window.dsh.respondPermission(requestId, decision)
  }
}))
