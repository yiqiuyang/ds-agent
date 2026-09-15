import os from 'node:os'
import type { KernelEvent, ShellCommand } from '../../shared/protocol'
import { DshProcess, resolveDshLaunch } from './dsh-process'
import { MockEngine } from './mock-engine'

/** 外壳与引擎进程的统一接口（dsh 真实进程 / mock 同构实现） */
export interface EngineProcess {
  readonly mode: 'dsh' | 'mock'
  start(): Promise<void>
  send(cmd: ShellCommand): void
  /** 用户主动停止；停止后不触发自动重启 */
  kill(): void
  onEvent(cb: (event: KernelEvent) => void): void
  /** 进程退出回调（mock 永不触发） */
  onExit(cb: (info: EngineExitInfo) => void): void
  /** I/O 活动回调（stdout/stderr 有任何输出，含无法解析的杂音；mock 永不触发） */
  onActivity(cb: () => void): void
}

export interface EngineExitInfo {
  code: number | null
  signal?: string
}

export interface EngineOptions {
  /** dsh 可执行文件路径；空 = 自动检测 PATH */
  dshPath: string
  profile: string
  workspaceDir: string
  forceMock: boolean
}

/** 启动后等待 engine.ready 的静默超时；期间有 I/O 活动则滑动重置（覆盖引擎初始化的长静默期） */
const READY_TIMEOUT_MS = 15_000
/** 崩溃自动重启上限 */
const AUTO_RESTART_LIMIT = 3
/** 稳定运行阈值：超过该时长后崩溃，重启计数清零 */
const STABLE_UPTIME_MS = 15_000
/** 快速退出判定阈值：启动后在该时长内退出视为「启动即退出」 */
const FAST_EXIT_MS = 10_000
/** 连续「启动即退出」次数上限：确定性失败（配置/协议不匹配），重启必败，快速失败 */
const FAST_EXIT_LIMIT = 2

/**
 * 引擎 Sidecar 生命周期管理器：
 * spawn / 事件监听与转发 / 崩溃自动重启（退避）/ Mock 与真实引擎切换。
 * 规范见 docs/protocol.md 第 8 节。
 */
export class DshEngineManager {
  private proc: EngineProcess | null = null
  private eventListener: ((event: KernelEvent) => void) | null = null
  private opts: EngineOptions | null = null

  private stopping = false
  private startPromise: Promise<'dsh' | 'mock'> | null = null
  private restartCount = 0
  private fastExits = 0
  private startedAt = 0
  private readyWatchdog: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null

  onEvent(cb: (event: KernelEvent) => void): void {
    this.eventListener = cb
  }

  private emit(event: KernelEvent): void {
    this.eventListener?.(event)
  }

  /** 启动引擎；并发调用复用同一次启动 */
  start(opts: EngineOptions): Promise<'dsh' | 'mock'> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart(opts).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async doStart(opts: EngineOptions): Promise<'dsh' | 'mock'> {
    await this.stop()
    this.opts = opts
    this.stopping = false
    this.emit({ type: 'engine.status', status: 'starting' })

    const resolved = opts.forceMock ? null : resolveDshLaunch(opts.dshPath)
    if (resolved) {
      try {
        await this.launch(
          new DshProcess(resolved, opts.profile, opts.workspaceDir || os.homedir())
        )
        return 'dsh'
      } catch (err) {
        // 检测通过但 spawn 失败（文件被移除等）：回退 mock，保证外壳可用
        const message = err instanceof Error ? err.message : String(err)
        this.emit({
          type: 'engine.error',
          message: `dsh 启动失败，回退 mock 引擎：${message}`,
          fatal: false
        })
        await this.stop()
      }
    }
    await this.launch(new MockEngine())
    return 'mock'
  }

  private async launch(proc: EngineProcess): Promise<void> {
    this.proc = proc
    this.startedAt = Date.now()
    proc.onEvent((event) => this.handleProcessEvent(event))
    proc.onExit((info) => this.handleExit(info))
    proc.onActivity(() => this.onEngineActivity(proc))
    await proc.start()
    this.armReadyWatchdog()
  }

  send(cmd: ShellCommand): void {
    if (!this.proc) {
      this.emit({ type: 'engine.error', message: '引擎未运行，无法发送命令', fatal: false })
      return
    }
    this.proc.send(cmd)
  }

  /** 用户主动停止：不触发自动重启 */
  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    const proc = this.proc
    this.proc = null
    proc?.kill()
  }

  private handleProcessEvent(event: KernelEvent): void {
    if (event.type === 'engine.ready') {
      this.clearTimers()
      // 引擎成功握手，历史「启动即退出」记录作废
      this.fastExits = 0
    }
    this.emit(event)
  }

  /** 子进程退出：区分用户主动停止与异常崩溃，后者按策略自动重启 */
  private handleExit(info: EngineExitInfo): void {
    if (this.stopping) return
    this.proc = null
    this.emit({ type: 'engine.exited', code: info.code, signal: info.signal })

    const uptime = Date.now() - this.startedAt
    if (uptime >= STABLE_UPTIME_MS) {
      // 稳定运行后崩溃：重置计数（区分偶发退出与崩溃循环）
      this.restartCount = 0
      this.fastExits = 0
    } else if (uptime < FAST_EXIT_MS) {
      this.fastExits++
    }

    // 连续「启动即退出」= 确定性失败（配置/协议不匹配），重启必败，快速失败
    if (this.fastExits >= FAST_EXIT_LIMIT) {
      this.emit({
        type: 'engine.error',
        message:
          '引擎启动后立即退出（连续快速失败，疑似配置或协议不匹配），已停止自动重启。请检查 profile 配置，或在设置中切换 Mock 引擎',
        fatal: true
      })
      return
    }

    if (this.opts && this.restartCount < AUTO_RESTART_LIMIT) {
      this.restartCount++
      const delay = 1000 * this.restartCount // 退避 1s / 2s / 3s
      this.emit({
        type: 'engine.status',
        status: 'restarting',
        message: `进程异常退出（code=${info.code ?? 'null'}），${delay / 1000}s 后自动重启（第 ${this.restartCount}/${AUTO_RESTART_LIMIT} 次）`
      })
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (this.opts && !this.stopping) void this.start(this.opts)
      }, delay)
    } else {
      this.emit({
        type: 'engine.error',
        message: '引擎多次异常退出，已停止自动重启，请手动重启引擎',
        fatal: true
      })
    }
  }

  /**
   * dsh 启动后限时等待 engine.ready（静默超时）；mock 同步发 ready 无需看门狗。
   * 等待期间引擎有任何 I/O 活动则滑动重置计时（见 onEngineActivity），
   * 避免杀掉正在初始化（如 dsh 首次 profile 安装依赖）的引擎。
   */
  private armReadyWatchdog(): void {
    if (this.proc?.mode !== 'dsh') return
    this.readyWatchdog = setTimeout(() => {
      this.readyWatchdog = null
      if (!this.proc || this.stopping) return
      void this.stop()
      this.emit({
        type: 'engine.error',
        message: `引擎启动超时（${READY_TIMEOUT_MS / 1000}s 静默，未收到 engine.ready 也无任何输出）`,
        fatal: true
      })
    }, READY_TIMEOUT_MS)
  }

  /** 引擎 I/O 活动信号：仅在看门狗计时中且来自当前进程时滑动重置（ready 后不再计时） */
  private onEngineActivity(proc: EngineProcess): void {
    if (!this.readyWatchdog || this.proc !== proc) return
    clearTimeout(this.readyWatchdog)
    this.armReadyWatchdog()
  }

  private clearTimers(): void {
    if (this.readyWatchdog) {
      clearTimeout(this.readyWatchdog)
      this.readyWatchdog = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }
}
