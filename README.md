# dsh-ris-yds

YonBIP YDS 客开后端的本地运行时，做成 **DSH 插件 + CLI** 双形态：

- **DSH 插件**：给 coding agent 提供一整套 `yds_*` 工具（体检 / 配置 / 凭据 / 运行时 / 集成 / 调试）。
- **CLI**（`bin/yds.js`，装包后 `yds` 命令）：同一套能力给人用（在终端或 IDE 里执行）。

在本地把后端运行时跑起来，用本地实例替代远端环境做开发联调。

## 截图

| 在 DSH 里管理本地服务：启停、实时日志、调试入口 |
|---|
| ![DSH 里的 RIS 控制台](https://raw.githubusercontent.com/ris-cloud/dsh-ris-yds/master/docs/screenshots/yds-run.png) |

| 内网访问规则（可选）：按程序 / 内网地址 / 端口放行，一次启用 |
|---|
| ![内网访问规则](https://raw.githubusercontent.com/ris-cloud/dsh-ris-yds/master/docs/screenshots/ris-proxy.png) |

## 能做什么

- **本地运行**：构建、启动、停止、查看状态与实时日志；启动失败自动回收，不留下半启动的进程。
- **平台配置**：从平台拉取配置并适配到本地运行时；支持离线缓存，网络不可达时也能启动。
- **内网访问**：数据库 / 缓存 / 内网服务可经代理或直连访问；本机其它客户端也能共用同一条隧道
  （需要系统权限的可选能力）。
- **平台凭据**：生成调用平台 API 的 YYCToken，新环境无需额外安装。
- **前端调试**：让远端页面加载本地前端资源，三种接入方式（浏览器扩展规则 / 请求改路 / URL 参数）。
- **IDE 面板**：在 dsh-ris-ide 面板里启停本地服务、查看实时日志、做 JDWP 断点调试。
- **外部 IDE**：本地运行时可被外部 IDE 直接 F5 启动调试。
- **浏览器回调校准**：确保工作台页面的请求回落到本机实例（失败时是静默的，自检可查）。
- **环境自检**：`yds doctor` 一次列出配置、运行时、端口、隧道等所有缺失项。

## 安装

```bash
# 公开 npm（推荐）
dsh plugin --profile web add dsh-ris-yds

# 或从本地 checkout 安装（开发调试）
dsh plugin --profile web add <本目录>
```

装完需**重启 `dsh web`**（宿主插件只在启动时组合一次，工具注册才生效）。新会话里 agent 就有
`yds_*` 工具；`skills/dsh-ris-yds` 会自动同步到项目 `.dsh/skills`。

前置：JDK 21 与 Maven 在 `PATH`（或在 `.env` 指定 `java.path` / `maven.settings`）。

## 快速开始

```bash
cd <你的 YonBIP 项目目录>

yds doctor          # 体检：配置解析、运行时、端口、隧道/缺失项
yds confcenter      # 拉取并适配平台配置（首次联网；之后可 --offline）
yds build           # 首次构建运行时（下载依赖，约 19 分钟；缓存后约 1 分钟）
yds start           # 后台启动（幂等；缺少配置/隧道会自动补）
yds status          # 进程、端口、就绪状态
yds logs --lines 200
yds stop
```

## 命令一览

| 命令 | 能力 |
|---|---|
| `yds doctor` / `yds config` / `yds token <url>` | 体检 / 生效配置（凭据打码）/ 生成平台 API 凭据 |
| `yds confcenter [--offline]` | 拉取并适配平台配置到本地运行时 |
| `yds build` | 构建本地运行时（首次下载依赖） |
| `yds start` / `yds stop [--keep-socks]` / `yds status` / `yds logs` | 本地运行时生命周期 |
| `yds ide apply\|check\|remove` | 本地运行时的 IDE 面板集成（启停 / 日志 / 调试） |
| `yds proxy [status\|sync\|start\|stop\|git-on\|git-off]` | 内网访问与 git 代理 |
| `yds browser [status\|fix] [--dry-run]` | 浏览器请求回调校准 |
| `yds fe [rules\|plan\|url <page>]` | 前端调试接入（扩展规则 / 请求改路 / URL 参数） |

## 配置（`.env` / 环境变量）

工作区根目录放一份 `.env` 即可，键名不带插件前缀；项目 `.vscode/settings.json` 的 `yds.*` 优先。

| 键 | 默认 | 说明 |
|---|---|---|
| `socks.host` / `socks.port` | 空 | 都空 = 直连；有值 = 代理模式 |
| `socks.dbPort` / `socks.redisPort` | 1521 / 6890 | 本机映射端口（JDBC/Redis 客户端用） |
| `ide.launch` | `proxy` | `proxy` / `direct`：外部 IDE 走代理还是直连 |
| `git.proxy` | `auto` | `off` 关闭 git 代理 |
| `local.ymsHome` | `<项目>/yms-home` | 本地运行时目录 |
| `maven.settings` / `maven.repo` | 空 | 构建用；留空用默认设置 |
| `java.path` | 空 | 指定 JDK（留空用 PATH） |

## 两种使用方式：代理 / 直连

| | 代理模式（有 `socks.*`） | 直连模式（无 `socks.*`） |
|---|---|---|
| 内网访问 | 经隧道；本机端口映射给 JDBC/Redis | 直接访问，不起任何隧道 |
| 本地运行时配置 | 改写成 `127.0.0.1` 映射地址 | 平台地址原样保留 |
| git 代理 | 自动按克隆地址主机写入 | 不写 |

同一台机器可以混合：dsh 走代理、外部 IDE 直连（`.env` 里设 `ide.launch=direct`）：

```bash
# .env: 保留 socks.host / socks.port，加 ide.launch=direct
yds confcenter   # 准备运行配置
yds ide apply    # 应用当前模式
```

切换模式只需改 `ide.launch` 后重新应用。

## 与 dsh-ris-ide 搭配（可选）

装上 [`dsh-ris-ide`](https://gitee.com/riscloud/dsh-ris-ide) 后，可在同一个 dsh 里获得：

- 启停本地服务、查看实时日志（只看本次启动）；
- JDWP 断点调试（线程、调用栈、变量）；
- 工作区文件树、编辑器、搜索与多文件粘贴。

两者**互不依赖**，可各自单独安装：没装 dsh-ris-ide 时本插件各项能力照常可用。

## 安全与边界（摘要）

- `workbenchUrl` 是**项目级信任根**：只对可信仓库执行 `yds build` / `yds start`。
- 本机转发端口无鉴权（单用户开发机可接受）。
- `yds token` 明文输出短期凭据，避免落盘。
- 涉及浏览器状态的命令支持 `--dry-run` 预览，不确定时先预览。

完整清单与实现理由见 [DEVELOPMENT.md](DEVELOPMENT.md) §15。

## 开发

- 架构、模块、内部机制（配置管线、隧道、模式隔离、IDE 集成、校准、发版）见
  **[DEVELOPMENT.md](DEVELOPMENT.md)**。
- 测试与自检：

  ```bash
  npm test               # node --test "test/*.test.mjs"
  npm run check:listing  # 上架自检（❌ 必须为 0）
  ```

- 目录：`lib/` 实现、`bin/` CLI、`native/` 原生凭据模块（6 平台）、`assets/` 浏览器扩展包、
  `test/` 测试、`skills/` dsh 技能。

## License

MIT
