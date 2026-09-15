import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BundleInfo, BundleProfile } from '../shared/bundles'
import { loadConfig } from './config'
import { bundledDshRoot } from './engine/dsh-process'

/**
 * dsh 的 bundle 装载机制（实证，见 docs/protocol.md 第 9 节）：
 * 每次启动读 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`
 * （包名数组，顺序即层叠序）逐层挂载；官方 `dsh plugin` 的 reconcile 也是直接
 * 改写该文件。外壳开关 = 编辑该数组，与官方机制同构，重启引擎即生效。
 */

/** 指定 profile 的目录（dsh 的 Harness home 下） */
function profileDirOf(profile: string): string {
  return path.join(os.homedir(), '.dsh', 'profiles', profile)
}

/** 从 profile package.json 宽容提取 dsh.profile.bundles（非法形态返回空数组） */
function extractBundlesArray(profile: unknown): string[] {
  if (profile == null || typeof profile !== 'object') return []
  const dsh = (profile as Record<string, unknown>).dsh
  const raw = dsh && typeof dsh === 'object' ? (dsh as Record<string, unknown>).profile : null
  const bundles = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).bundles : null
  if (!Array.isArray(bundles)) return []
  return bundles.filter((item): item is string => typeof item === 'string' && !!item)
}

/** 已安装 bundle 的元信息（声明 dsh.bundle 的包） */
interface BundleMeta {
  name: string
  description?: string
}

/** 读一个包目录的元信息；仅当声明 dsh.bundle（是 bundle）时返回，否则 null */
function readBundleMeta(pkgDir: string): BundleMeta | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')) as {
      name?: unknown
      description?: unknown
      dsh?: { bundle?: unknown } | null
    }
    if (!pkg.dsh || typeof pkg.dsh !== 'object' || pkg.dsh.bundle === undefined) return null
    return {
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : path.basename(pkgDir),
      description: typeof pkg.description === 'string' && pkg.description ? pkg.description : undefined
    }
  } catch {
    return null
  }
}

/** 枚举一个 node_modules 根下的候选包目录（根级 + @scope 下） */
function* candidatePkgDirs(root: string): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scope = path.join(root, entry.name)
      let scoped: fs.Dirent[]
      try {
        scoped = fs.readdirSync(scope, { withFileTypes: true })
      } catch {
        continue
      }
      for (const pkg of scoped) {
        if (pkg.isDirectory() && !pkg.name.startsWith('.')) yield path.join(scope, pkg.name)
      }
    } else {
      yield path.join(root, entry.name)
    }
  }
}

/**
 * 扫描已安装的 bundle 池（声明 dsh.bundle 的包），两个锚点与 dsh 的
 * resolveBundleDir 一致：vendor 安装（in-box）优先，profile 共享目录补充。
 */
function scanInstalledBundles(): Map<string, BundleMeta> {
  const pool = new Map<string, BundleMeta>()
  const roots = [
    path.join(bundledDshRoot(), 'node_modules'),
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules')
  ]
  for (const root of roots) {
    for (const pkgDir of candidatePkgDirs(root)) {
      const meta = readBundleMeta(pkgDir)
      if (meta && !pool.has(meta.name)) pool.set(meta.name, meta)
    }
  }
  return pool
}

/** 读取当前 profile 的 bundle 状态：已启用列表（数组顺序）+ 已安装未启用池 */
export function loadBundleProfile(): BundleProfile {
  const cfg = loadConfig()
  const dir = profileDirOf(cfg.profile)
  const manifestPath = path.join(dir, 'package.json')
  const base: BundleProfile = { profileName: cfg.profile, path: manifestPath, found: false, profile: null, bundles: [] }
  if (!fs.existsSync(manifestPath)) return base
  let profile: unknown
  try {
    profile = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ...base, found: true, error: `profile package.json 解析失败：${message}` }
  }

  const enabledList = extractBundlesArray(profile)
  const pool = scanInstalledBundles()
  const bundles: BundleInfo[] = enabledList.map((id) => {
    const meta = pool.get(id)
    pool.delete(id)
    return { id, name: meta?.name ?? id, description: meta?.description, enabled: true }
  })
  // 已安装未启用（按包名排序）
  const rest = [...pool.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [id, meta] of rest) {
    bundles.push({ id, name: meta.name, description: meta.description, enabled: false })
  }
  return { ...base, found: true, profile, bundles }
}

/** 写回 profile package.json（与官方 writeProfileManifest 同格式：JSON 2 空格 + 换行） */
function writeProfileManifest(dir: string, manifest: unknown): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
}

/**
 * 切换 bundle 启用状态：编辑 profile package.json 的 dsh.profile.bundles 数组
 * （启用 = 追加到尾部；禁用 = 移除），重启引擎后生效。
 */
export function setBundleEnabled(id: string, enabled: boolean): BundleProfile {
  const cfg = loadConfig()
  const dir = profileDirOf(cfg.profile)
  const manifestPath = path.join(dir, 'package.json')
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('profile package.json 结构异常，无法写入 bundles')
  }
  const record = { ...(manifest as Record<string, unknown>) }
  const dsh = (record.dsh && typeof record.dsh === 'object' ? record.dsh : {}) as Record<string, unknown>
  const dshProfile = (dsh.profile && typeof dsh.profile === 'object' ? dsh.profile : {}) as Record<string, unknown>
  const bundles = extractBundlesArray(record)
  const next = enabled ? (bundles.includes(id) ? bundles : [...bundles, id]) : bundles.filter((b) => b !== id)
  dshProfile.bundles = next
  dsh.profile = dshProfile
  record.dsh = dsh
  writeProfileManifest(dir, record)
  return loadBundleProfile()
}
