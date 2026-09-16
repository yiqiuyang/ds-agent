import { create } from 'zustand'
import type {
  EngineStatus,
  PermissionDecision,
  SessionListItem
} from '../../shared/protocol'

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

/** 会话历史面板状态（session/list 事件驱动） */
export interface SessionListState {
  sessions: SessionListItem[]
  /** 续页游标；null = 已到末页 */
  nextCursor: string | null
  loading: boolean
}

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
  /** 当前引擎会话 id（engine.ready / session.switched 维护） */
  sessionId: string | null
  /** 历史会话列表；null = 尚未请求过 */
  sessionList: SessionListState | null

  setView: (view: View) => void
  appendUserMessage: (text: string) => void
  respondPermission: (requestId: string, decision: PermissionDecision) => void
  /** 请求历史会话列表（cursor 为续页游标） */
  loadSessions: (cursor?: string) => void
  newSession: () => void
  resumeSession: (sessionId: string) => void
}

export const useShell = create<ShellState>((set) => ({
  status: 'starting',
  engine: null,
  timeline: [],
  streamingMessageId: null,
  pendingPermission: null,
  view: 'chat',
  sessionId: null,
  sessionList: null,

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
  },

  loadSessions: (cursor) => {
    set((s) => ({
      sessionList: {
        // 续页：保留已加载条目，追加在本页之后
        sessions: cursor ? (s.sessionList?.sessions ?? []) : [],
        nextCursor: s.sessionList?.nextCursor ?? null,
        loading: true
      }
    }))
    void window.dsh.listSessions(cursor)
  },

  newSession: () => {
    void window.dsh.newSession()
  },

  resumeSession: (sessionId) => {
    void window.dsh.resumeSession(sessionId)
  }
}))
