import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'

const WEB_DSH_PACKAGE = '@deepseek-ai/dsh'

/** 就绪静默超时：启动后该时长内未解析到 URL 视为失败 */
const READY_TIMEOUT_MS = 15_000
/** 崩溃自动重启上限（退避 1s/2s/3s） */
const AUTO_RESTART_LIMIT = 3

/** web profile 的捆绑运行时根目录（dsh 0.1.1-rc.2 + dsh-directorx） */
export function webDshRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh-web')
    : path.join(app.getAppPath(), 'vendor', 'dsh-web')
}

/** 解析 vendor 捆绑 dsh 的 JS 入口（web profile） */
function resolveWebEntry(): string {
  return path.join(webDshRoot(), 'node_modules', WEB_DSH_PACKAGE, 'lib', 'bin.js')
}

/**
 * web profile 引擎：spawn `dsh --profile web --no-open --port 0`，
 * 从 stdout 解析实际端口（`dsh web: http://127.0.0.1:<port>`，无 token），
 * 带就绪看门狗与崩溃自动重启。
 */
export class WebEngine {
  private child: ChildProcess | null = null
  private buffer = ''
  private url: string | null = null
  private stopping = false
  private restartCount = 0
  private readyTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null

  onReady: ((url: string) => void) | null = null
  onError: ((message: string) => void) | null = null

  start(): void {
    this.stopping = false
    this.restartCount = 0
    this.launch()
  }

  private launch(): void {
    this.buffer = ''
    this.url = null
    const entry = resolveWebEntry()
    let child: ChildProcess
    try {
      child = spawn(
        process.execPath,
        ['--expose-internals', entry, '--profile', 'web', '--no-open', '--port', '0'],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
    } catch (err) {
      this.onError?.(`dsh web 启动失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.child = child

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => console.warn('[dsh-web]', chunk.trimEnd()))
    child.on('error', (err) => {
      this.child = null
      this.clearTimers()
      this.onError?.(`dsh web 进程错误：${err.message}`)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      this.clearTimers()
      if (this.stopping) return
      this.handleExit(code, signal ?? undefined)
    })

    this.readyTimer = setTimeout(() => {
      if (this.url || this.stopping) return
      this.onError?.('dsh web 启动超时（15s 内未解析到 URL）')
      this.kill()
    }, READY_TIMEOUT_MS)
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    if (this.url) return
    const match = this.buffer.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/)
    if (match) {
      this.url = match[1]
      if (this.readyTimer) {
        clearTimeout(this.readyTimer)
        this.readyTimer = null
      }
      this.restartCount = 0
      this.onReady?.(this.url)
    }
  }

  private handleExit(code: number | null, signal?: string): void {
    if (this.restartCount < AUTO_RESTART_LIMIT) {
      this.restartCount++
      const delay = 1000 * this.restartCount
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!this.stopping) this.launch()
      }, delay)
    } else {
      this.onError?.('dsh web 引擎多次异常退出，已停止自动重启')
    }
  }

  private clearTimers(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  kill(): void {
    this.stopping = true
    this.clearTimers()
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.stdin?.end()
      } catch {
        // 忽略
      }
      child.kill()
    }
  }
}
