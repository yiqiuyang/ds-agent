/** Bundle（dsh 能力包）可视化：外壳与渲染层共享的类型 */

export interface BundleInfo {
  /** bundle 包名（dsh.profile.bundles 数组的成员标识） */
  id: string
  /** 展示名（包 package.json 的 name，缺省为 id） */
  name: string
  description?: string
  /** 启用中：存在于当前 profile 的 dsh.profile.bundles 数组 */
  enabled: boolean
}

/** 当前 profile 的 bundle 状态（dsh.profile.bundles 数组 + 已安装可启用的 bundle 池） */
export interface BundleProfile {
  /** 当前 profile 名（外壳配置 cfg.profile） */
  profileName: string
  /** profile 目录的 package.json 路径 */
  path: string
  /** 是否成功读到文件 */
  found: boolean
  /** 读取/解析错误信息 */
  error?: string
  /** package.json 原始解析结果，用于 JSON.stringify 预览 */
  profile: unknown
  /** 已启用（保持 profile 数组顺序）+ 已安装未启用（bundle 池） */
  bundles: BundleInfo[]
}
