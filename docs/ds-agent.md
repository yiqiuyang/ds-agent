# DSH 桌面版 Web Profile 集成 DirectorX — 开发文档

**版本**：v3.1（修订版）
**日期**：2026-09-16
**定位**：以 `web` profile 启动 DSH 引擎，在 Electron 桌面外壳中加载 DSH Web UI，集成 DirectorX 视频生产插件

------

## 修订记录

| 序号 | 修订项                            | 说明                                                         |
| :--- | :-------------------------------- | :----------------------------------------------------------- |
| 1    | `BrowserView` → `WebContentsView` | 适配 Electron 30+ 官方推荐，避免弃用 API                     |
| 2    | DSH 版本锁死                      | 明确锁定 `0.1.0-rc.7+`，DirectorX 锁到具体 commit            |
| 3    | CLI 输出格式先验证                | 不假设 stdout 格式，Phase 0 实际跑 `dsh web` 观察            |
| 4    | vendor 构建方式明确               | 新增 `DshRuntimeManager`，CI 物化生产依赖，禁止直接复制 dev `node_modules` |
| 5    | 认证机制独立 POC                  | Phase 1 只做认证链路，跑通前不碰 DirectorX / FFmpeg / 审批   |
| 6    | Electron Node 版本探测            | Phase 0 第一步验证 Node ≥ 22.19                              |
| 7    | Cookie 验证探针                   | 加载 token URL 后主动查 cookie，不假设成功                   |
| 8    | stdout 解析加 ANSI strip          | 避免颜色码导致正则匹配失败                                   |
| 9    | 打包后路径统一走 `app.isPackaged` | 禁止业务代码拼 `__dirname` 相对路径                          |
| 10   | 实施阶段重新拆分为 Phase 0–4      | Phase 0/1 为硬门槛，跑不通不往下走                           |
| 11   | Phase 0 实测修正（2026-09-16）    | dsh 锁 `0.1.1-rc.2`、vendor 用 pnpm、spawn 加 `--expose-internals`、URL 无 token、双版本 vendor |

------

## 1. 架构概述

### 1.1 核心决策

| 决策项              | 选择                                                         | 理由                                                        |
| :------------------ | :----------------------------------------------------------- | :---------------------------------------------------------- |
| **Profile**         | `web`                                                        | DirectorX 的画布是 DSH Web UI 客户端插件，headless 下不渲染 |
| **DSH 启动方式**    | `dsh --profile web --no-open --port 0`                       | 动态端口避免冲突，`--no-open` 阻止自动打开系统浏览器        |
| **Web UI 加载方式** | Electron `WebContentsView` 加载 `http://127.0.0.1:<port>/`   | 保留 DirectorX 完整画布体验；`BrowserView` 已弃用           |
| **端口解析**        | 从 stdout 解析 `dsh web: http://127.0.0.1:<port>/?token=<token>`（0.1.5-rc.1 已实测；0.1.1-rc.2 无 token） | 加载 token URL → 303 设签名 cookie → 重定向到 `/`；无 token 访问返回 401  |
| **运行时**          | Electron 内嵌 Node（`ELECTRON_RUN_AS_NODE=1`），**Phase 0 验证 Node ≥ 22.19** | 复用 Electron 二进制，无需独立 Node                         |
| **FFmpeg**          | 捆绑到 `vendor/ffmpeg/`，通过 `PATH` + `DSH_FFMPEG_PATH` 注入 | DirectorX 剪辑管线依赖本地 FFmpeg；**Phase 3 才接入**       |
| **路径管理**        | 统一走 `DshRuntimeManager`                                   | 开发/生产双模式，禁止业务代码散落拼路径                     |

### 1.2 总体架构

text

```
┌──────────────────────────────────────────────────────────┐
│                  Electron 主进程                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  DshEngineManager                                  │  │
│  │  · spawn dsh --profile web --no-open --port 0     │  │
│  │  · 解析 stdout 获取实际端口和认证 token（待实测）    │  │
│  │  · 健康检查 / 崩溃重启 / 退出清理                   │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  WebContentsView（加载 DSH Web UI）                │  │
│  │  · http://127.0.0.1:<port>/                       │  │
│  │  · 先加载 token URL → 建立 cookie → 重定向到 /    │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  原生层（设置向导 / 任务栏 / 托盘 / 通知）          │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│               DSH 引擎层（Sidecar 子进程）                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Profile: web                                     │  │
│  │  bundles: [dsh-base, dsh-web-app, dsh-directorx]  │  │
│  │  ┌──────────────────────────────────────────────┐ │  │
│  │  │  DirectorX Plugin                             │ │  │
│  │  │  画布 / 工具 / 知识库 / 配方 / 设置           │ │  │
│  │  └──────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ vendor/dsh   │  │ vendor/ffmpeg│  │ Electron Node│   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
├──────────────────────────────────────────────────────────┤
│                    外部能力层                              │
│  DeepSeek  │  图片模型  │  视频模型  │  TTS 模型         │
└──────────────────────────────────────────────────────────┘
```



### 1.3 Web Profile 的加载链路

DSH 内置 `web` profile 模板为 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`。`dsh-base` 提供 LLM、Agent、Session、Sandbox、Permission、工具、Goal、Plan 等核心能力；`dsh-web-app` 叠加 Web Runtime（web-startup、webserver、web-runtime、api-gateway、workspace、storage 等）。

DirectorX 作为 bundle 追加到 profile 的 bundles 列表末尾，其 `cordis.patch.yml` 会在 `dsh-web-app` 之后叠加，将视频生产工具、技能、设置命名空间和 Web 路由注入配置树。

加载顺序：**空配置树 → dsh-base → dsh-web-app → dsh-directorx → 用户 cordis.patch.yml**

------

## 2. 环境准备

### 2.1 vendor 目录布局

text

```
vendor/
├── dsh/                          # acp 外壳运行时（dsh 0.1.5-rc.1）
│   ├── package.json              # 锁定 @deepseek-ai/dsh
│   ├── pnpm-lock.yaml
│   └── node_modules/             # 由 CI 物化，不提交 git
├── dsh-web/                      # web + DirectorX 运行时（dsh 0.1.1-rc.2）
│   ├── package.json              # 锁定 @deepseek-ai/dsh + dsh-directorx
│   ├── pnpm-lock.yaml
│   └── node_modules/             # 由 CI 物化，不提交 git
├── ffmpeg/                       # FFmpeg 二进制
│   ├── ffmpeg                    # macOS/Linux
│   └── ffmpeg.exe                # Windows
└── profiles/
    └── web/                      # 预置 profile（可选，也可用 DSH 内置 web profile）
```



### 2.2 vendor 目录 package.json（版本锁死）

> **双版本（Phase 0 实证）**：下面这个含 `dsh-directorx` 的 JSON 是 **`vendor/dsh-web`** 的；`vendor/dsh`（acp 外壳）只锁 `@deepseek-ai/dsh@^0.1.5-rc.1`，不含 directorx。

json

```
{
  "name": "dsh-runtime",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.1-rc.2",
    "dsh-directorx": "github:LaplaceYoung/dsh-directorx#<commit-sha>"
  }
}
```



**要求**：

- `@deepseek-ai/dsh` 锁定到 Phase 0 验证通过的具体版本 `0.1.1-rc.2`（DirectorX 最新实际要求；`0.1.0-rc.7` 已过时）。
- `dsh-directorx` 锁定到具体 commit，避免 GitHub 源漂移。
- 提交 `package-lock.json`，`.gitignore` 只忽略 `node_modules/`。

### 2.3 生产依赖物化（CI 构建步骤）

禁止直接把开发时的 `node_modules` 复制进安装包。CI 中执行：

bash

```
cd vendor/dsh
pnpm install --prod
# 注意：不能用 npm——npm 解析 dsh 的 600+ 包依赖树会永久卡死（Phase 0 实证）；用 pnpm
```



### 2.4 安装 DirectorX 到 web profile（Phase 2）

bash

```
# 开发阶段：命令行安装
dsh plugin --profile web add dsh-directorx

# 本地路径安装
dsh plugin --profile web add link:$(pwd)/packages/dsh-directorx
```



`dsh plugin add` 会转发 pnpm，将声明了 `dsh.bundle` 的依赖加进 profile 的层栈。安装后 `dsh.profile.bundles` 列表自动更新。

> **注意（Phase 0 实证）**：这只把插件装进 profile 的 `node_modules`。外壳从 vendor 拉起 dsh 时，cordis 加载器锚定在 vendor 树，解析不到 profile 里的插件——**插件必须同时装进 vendor**（即 §2.2 的 vendor `package.json` 同时锁 `dsh-directorx`）。

------

## 3. 核心开发任务

### 3.1 引擎启动与端口解析（Phase 0 先实测）

**启动命令**：

ts

```
const child = spawn(process.execPath, [
  '--expose-internals', // web profile 的 HMR 服务硬性要求（Phase 0 实证）
  dshEntry,
  '--profile', 'web',
  '--no-open',
  '--port', '0'
], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`,
    DSH_FFMPEG_PATH: ffmpegPath,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
```



**端口与认证 token 解析（待实测确认）**：

Phase 0 必须先跑：

bash

```
dsh --profile web --no-open --port 0
```



Phase 0 实测（2026-09-16）：

- 打印 `dsh web: http://127.0.0.1:<port>/?token=<token>`（0.1.5-rc.1 带 token；0.1.1-rc.2 无）。
- 无 ANSI 颜色码，单行输出。
- 认证：带 token 访问返回 `303`（设签名 cookie 后重定向到 `/`）；无 token 访问 `/` 返回 `401`。

**解析代码（待实测后调整正则）**：

ts

```
child.stdout.on('data', (data) => {
  // 先 strip ANSI 颜色码
  const clean = data.toString().replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n');
  for (const line of lines) {
    const match = line.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\S*)/);
    if (match) {
      const url = match[1];
      const portMatch = url.match(/:(\d+)/);
      if (portMatch) {
        this.port = parseInt(portMatch[1]);
        this.webUrl = url;
        this.emit('ready', { port: this.port, url: this.webUrl });
      }
    }
  }
});
```



**要求**：

- 解析失败时**明确报错**，不静默。
- 同时监听 stderr。
- 15 秒内未解析到 URL 则降级为固定端口重试。
- 增加 `--verbose` 模式，将原始 stdout/stderr 写入日志文件。

### 3.2 WebContentsView 加载 Web UI（替代 BrowserView）

ts

```
import { BaseWindow, WebContentsView } from 'electron';

const win = new BaseWindow({
  width: 1440,
  height: 900,
});

const view = new WebContentsView({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});

win.contentView.addChildView(view);
view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
view.setAutoResize({ width: true, height: true });

// 先加载带 token 的 URL 完成认证（0.1.5-rc.1）
view.webContents.loadURL(engine.webUrl);
```



**认证验证探针**：

ts

```
view.webContents.on('did-finish-load', async () => {
  const cookies = await session.defaultSession.cookies.get({
    url: `http://127.0.0.1:${engine.port}/`
  });
  if (cookies.length === 0) {
    // 认证失败，记录日志并提示
  }
});
```



认证链路：先 `loadURL` 带 token 的 URL，服务端校验后设签名 cookie 并 303 重定向到 `/`，WebContentsView 持有 cookie 正常加载。无 token 直接访问 `/` 返回 401。

### 3.3 审批弹窗的通信桥接（Phase 2 再考虑）

DirectorX 的 `directorx_confirm` 通过 DSH 的 `ctx.userQuestions.ask` 在 Web UI 内渲染审批卡片。web profile 下审批默认在 WebContentsView 内完成。

**Phase 2 阶段策略**：

- **方案 A（MVP）** ：审批完全在 WebContentsView 内完成，外壳只负责窗口置顶/闪烁任务栏。
- **方案 B（P1）** ：主进程连接 DSH WebSocket 旁听 `permission.request`，弹出原生对话框，用户选择后通过注入脚本写回。

ts

```
import WebSocket from 'ws';
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
ws.on('message', (data) => {
  const event = JSON.parse(data);
  if (event.type === 'permission.request') {
    win.webContents.send('show-approval', event.payload);
  }
});
```



### 3.4 FFmpeg 捆绑与环境变量注入（Phase 3）

推荐“直接配置临时环境变量”：

ts

```
const ffmpegDir = app.isPackaged
  ? path.join(process.resourcesPath, 'ffmpeg')
  : path.join(app.getAppPath(), 'vendor', 'ffmpeg');

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`,
  DSH_FFMPEG_PATH: path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
};
```



这样 FFmpeg 对子进程及其派生进程都可见。

### 3.5 DshRuntimeManager（新增）

ts

```
class DshRuntimeManager {
  private base(): string {
    return app.isPackaged ? process.resourcesPath : app.getAppPath();
  }

  resolveDshEntry(): string {
    return path.join(this.base(), 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }

  resolveNodeBinary(): string {
    return process.execPath; // 配合 ELECTRON_RUN_AS_NODE
  }

  resolveFfmpegPath(): string {
    const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    return path.join(this.base(), 'ffmpeg', name);
  }

  resolveProfileDir(): string {
    return path.join(this.base(), 'profiles', 'web');
  }

  validate(): ValidationResult {
    // 检查入口存在、Node 版本 ≥ 22.19、原生模块 ABI
  }
}
```



**要求**：业务代码一律通过此 manager 获取路径，禁止散落拼路径。

### 3.6 打包配置

yaml

```
extraResources:
  - from: vendor/dsh
    to: dsh
    filter: ["**/*", "!**/*.md", "!**/test/**", "!**/*.map"]
  - from: vendor/ffmpeg
    to: ffmpeg
```



打包后路径：

- DSH 运行时：`process.resourcesPath/dsh/`
- FFmpeg：`process.resourcesPath/ffmpeg/`

------

## 4. 关键文件清单

| 文件                                     | 动作 | 说明                                                         |
| :--------------------------------------- | :--- | :----------------------------------------------------------- |
| `vendor/dsh/package.json`                | 新建 | 锁定 `@deepseek-ai/dsh` + `dsh-directorx`                    |
| `src/main/engine/dsh-process.ts`         | 修改 | 启动参数改为 `--profile web --no-open --port 0`；增加端口和 token 解析（待实测） |
| `src/main/engine/dsh-runtime-manager.ts` | 新建 | 统一路径解析与校验                                           |
| `src/main/window-manager.ts`             | 新建 | `BaseWindow` + `WebContentsView` 创建、加载、窗口管理        |
| `src/main/engine/event-bus.ts`           | 修改 | 保留 stdio 事件流；Phase 2 增加 WebSocket 旁听（可选）       |
| `src/renderer/views/SetupWizard.tsx`     | 新建 | 四类模型配置向导（Phase 4）                                  |
| `package.json`                           | 修改 | electron-builder `extraResources` 配置                       |

------

## 5. 实施阶段（重新拆分）

### Phase 0：环境与 CLI 实测（1 天）

**目标**：证明 Electron Node 版本满足要求，DSH CLI 输出格式明确，DirectorX 可安装。

**任务**：

1. `ELECTRON_RUN_AS_NODE=1 electron -e "console.log(process.versions.node, process.versions.modules)"` → 确认 Node ≥ 22.19。
2. `dsh --profile web --no-open --port 0` → 观察 stdout/stderr，记录 URL 格式、token 参数名、ANSI 码、输出节奏。
3. `dsh plugin --profile web add dsh-directorx` → 确认能安装。
4. 检查 `vendor/dsh/node_modules` 是否有 `.node` 原生模块。

**验收**：

- Node 版本满足。
- CLI 输出格式记录在案，解析正则确定。
- DirectorX 安装成功。
- 原生模块 ABI 风险已知（若有，记录应对方案）。

**跑不通不进入 Phase 1。**

### Phase 1：认证链路 POC（3–5 天）

**目标**：Electron 拉起 DSH，WebContentsView 显示 DSH Web UI，认证链路跑通。

**任务**：

1. 实现 `DshEngineManager`，spawn `dsh --profile web --no-open --port 0`。
2. 解析 stdout 拿到端口和 token URL。
3. 创建 `BaseWindow` + `WebContentsView`，加载 token URL。
4. 监听 `did-finish-load`，主动查 cookie 验证认证成功。
5. 确认重定向到 `/` 后 Web UI 正常显示，可正常对话。

**验收**：

- 双击应用 → DSH 自动启动 → Web UI 自动打开 → 可正常操作。
- Cookie 探针确认签名 cookie 存在。
- 退出应用后无残留 DSH 子进程。

**跑不通不进入 Phase 2。**

### Phase 2：接入 DirectorX（3–5 天）

**目标**：DirectorX 画布渲染，用 mock 跑通 brief → 确认 → 画布 → 时间线。

**任务**：

1. 在 web profile 中安装 DirectorX。
2. 启动引擎，确认画布正常渲染。
3. 配置四类模型（先用 mock）。
4. 走通一次完整流程：brief → 确认 → 画布 → 时间线。
5. 观察审批卡片是否在 Web UI 内正常渲染。

**验收**：

- 画布渲染成功。
- mock 流程可走通。
- 审批卡片出现并可操作。

### Phase 3：接入 FFmpeg（3–5 天）

**目标**：验证图片 → 视频 → 剪辑 → 字幕 → 混音 → 输出。

**任务**：

1. 捆绑 FFmpeg 到 `vendor/ffmpeg/`。
2. 启动时注入 `PATH` 和 `DSH_FFMPEG_PATH`。
3. 用 mock 素材走通完整剪辑管线。
4. 验证 `DSH_FFMPEG_PATH` 生效。

**验收**：

- 一条完整成片产出。
- FFmpeg 在打包后路径正确。

### Phase 4：桌面应用体验（持续）

**目标**：原生菜单、托盘、通知、自动更新、设置向导、日志、崩溃恢复、打包。

**任务**：

- 原生菜单 / 托盘 / 通知
- 自动更新
- 设置向导（四类模型配置）
- 日志与诊断
- 崩溃恢复
- DSH 子进程清理
- Windows / macOS 打包

------

## 6. 验收标准

| 编号  | 验收条件                                                    | 阶段    |
| :---- | :---------------------------------------------------------- | :------ |
| P0-01 | Electron Node 版本 ≥ 22.19                                  | Phase 0 |
| P0-02 | DSH CLI 输出格式确认，解析正则确定                          | Phase 0 |
| P0-03 | DirectorX 可安装                                            | Phase 0 |
| P1-01 | 双击应用后 DSH 引擎 15 秒内启动并打印 URL                   | Phase 1 |
| P1-02 | 从 stdout 正确解析端口号和认证 token                        | Phase 1 |
| P1-03 | WebContentsView 加载 DSH Web UI，认证通过                   | Phase 1 |
| P1-04 | Cookie 探针确认签名 cookie 存在                             | Phase 1 |
| P1-05 | 退出应用后无残留 DSH 子进程                                 | Phase 1 |
| P2-01 | DirectorX 画布正常渲染                                      | Phase 2 |
| P2-02 | mock 流程 brief → 确认 → 画布 → 时间线走通                  | Phase 2 |
| P2-03 | 审批卡片在 Web UI 内正常渲染                                | Phase 2 |
| P3-01 | FFmpeg 捆绑并注入成功                                       | Phase 3 |
| P3-02 | 图片 → 视频 → 剪辑 → 字幕 → 混音 → 输出走通                 | Phase 3 |
| P4-01 | 打包后 `resources/dsh/` 和 `resources/ffmpeg/` 存在且可执行 | Phase 4 |
| P4-02 | 可分发安装包，跨平台验证                                    | Phase 4 |

------

## 7. 风险与应对

| 风险                                | 概率   | 影响 | 应对                                                         |
| :---------------------------------- | :----- | :--- | :----------------------------------------------------------- |
| **Electron 内嵌 Node 版本 < 22.19** | 中     | 高   | Phase 0 探测；若不满足，回退独立 Node 二进制                 |
| **CLI 输出格式与假设不符**          | 中     | 高   | Phase 0 实测；解析失败时明确报错，降级固定端口               |
| **BrowserView 弃用**                | 已解决 | —    | 改用 `WebContentsView`                                       |
| **DSH 版本漂移**                    | 高     | 中   | 锁定 `0.1.0-rc.7`，提交 lockfile                             |
| **DirectorX 依赖的 npm 包不可用**   | 中     | 高   | 从 DSH 源码仓库通过 pnpm 安装，或使用 `link:`                |
| **原生模块 ABI 不兼容**             | 中     | 高   | Phase 0 检查 `.node` 文件；必要时 `electron-rebuild` 或独立 Node |
| **认证链路失败**                    | 中     | 高   | Phase 1 独立 POC；cookie 探针；备用 `--trusted-host`         |
| **FFmpeg 打包后路径错误**           | 低     | 中   | 统一走 `DshRuntimeManager`；打包后验证                       |
| **WebContentsView 与外壳通信复杂**  | 中     | 中   | MVP 阶段审批在 Web UI 内完成；P1 再考虑 WebSocket 旁听       |

------

## 8. 与 acp profile 的切换预留

| 改动点   | web → acp                                                    |
| :------- | :----------------------------------------------------------- |
| 启动参数 | `--profile acp` 替代 `--profile web`                         |
| 通信协议 | WebSocket 事件流 → JSON-RPC 2.0 over NDJSON/stdio            |
| 画布     | 丧失 DirectorX 画布，需自行实现                              |
| 审批     | 从 Web UI 内联卡片 → 收到 `session/request_permission` 后自行渲染 |
| 配置     | 从 DirectorX 设置页 → 自行实现配置读写                       |

**建议**：在 `DshEngineManager` 中预留 `profileType: 'web' | 'acp'` 配置项，切换时只需改启动参数和通信适配器，不影响上层业务逻辑。

> **版本约束（Phase 0 实证）**：acp 与 web 需要**不同的 dsh 版本**，单版本无法同时满足——
> - `vendor/dsh` → dsh `0.1.5-rc.1`（acp 外壳；launcher 提供 `appReady`）
> - `vendor/dsh-web` → dsh `0.1.1-rc.2` + `dsh-directorx`（web+DirectorX；有 `subagents.registerContinuableSetup`）
>
> 因此切换 profileType 不止改启动参数，还要切换对应的 vendor 目录。

------

**文档结束。核心结论：Phase 0 和 Phase 1 是硬门槛，先验证 Electron Node 版本、DSH CLI 输出格式、认证链路，跑通后再进入 DirectorX 集成。**