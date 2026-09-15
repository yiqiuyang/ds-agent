/**
 * Bundle（dsh 能力包）的类型定义。
 * profile.json 的内部 schema 归 dsh 所有，外壳只做列表 / 开关 / 预览。
 * 详见 docs/protocol.md §8。
 */

/** 主进程扫描文件系统生成的 bundle 元信息 */
export interface BundleInfo {
  /** bundle 目录名 / 稳定标识 */
  id: string
  /** 展示名（来自 profile.json 的 name 字段，缺省用 id） */
  name: string
  description?: string
  /** profile.json 绝对路径 */
  path: string
  /** 是否启用（外壳配置存储） */
  enabled: boolean
  /** profile.json 原始内容，前端 JSON.stringify 预览 */
  profile: unknown
}
