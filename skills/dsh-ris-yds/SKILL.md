---
name: dsh-ris-yds
description: How to run the YonBIP YDS backend locally with the dsh-ris-yds tools — config resolution (settings.json + optional .env), YYCToken, confcenter sync, SOCKS forward, yms-home build/start/stop, and ris_dev JDWP debugging. Use when asked to start/stop/debug the yds backend, generate YYCToken, pull confcenter config, or wire the YMS program into dsh-ris-ide.
---

# dsh-ris-yds — YonBIP YDS 本地运行时

本地跑 `c-ass-kk-hans`（YDS 客）后端 = 在 yms-home 里起一个 YMS（WebSphere Liberty）容器，
应用 WAR 部署在容器里。所有机器相关值来自配置文件，本 skill 不依赖任何写死的 IP。

## 配置模型（动手前先 `yds_doctor`）

| 来源 | 文件 | 性质 |
|---|---|---|
| 项目配置 | `<project>/.vscode/settings.json`（yds.* 键） | **只读**（YonCode 标准格式，共用工作区不破坏） |
| 机器配置 | `<workspace>/.env`（可选，KEY=VALUE） | SOCKS 代理、git 凭据、本机端口覆盖 |
| 环境变量 | `YDS_SOCKS_HOST` 等 | 临时覆盖 |

关键键：`yds.workbenchUrl / accessKey / accessSecret / serverBindAddress / serverPort / env`（项目）；
`socks.host/port`（SOCKS 存在→DB/Redis 走本地转发；不存在→直连）。本地监听端口**自动选空闲端口**（从回调端口 +2 起找），不需要配置。
回调地址 = serverBindAddress:serverPort；本地监听端口默认=serverPort，WSL mirrored/端口冲突时用
本地端口自动错开，无需配置（Windows 侧可用 portproxy 把回调端口映射回来）。

**`.env` 自动补模板 + 主动提问**：仅在确认是 yds 项目时（工作区里有带 `yds.*` 键的 `.vscode/settings.json`；
其它目录不动 `.env`）才生效——任何 `yds_*` 命令加载配置时都会检查 `.env`，缺
`git.url` / `socks.host` / `socks.port` / `proxy.javaRules` 就追加**注释占位**（`#key=`，只追加不覆盖），
并在输出里给出 `[yds] 待补齐配置（未生效）: …`。看到这行时**不要自己猜值**：用提问工具向用户确认
这些配置，拿到后把对应行改成 `key=<值>`，再重跑原命令；用户说本机不需要，就在 `.env` 追加
`# yds: 配置已确认（无需补齐）` 停止提醒。写值前不要回显敏感内容（`git.url` 里若带凭据要打码）。

## 标准流程（新环境从零）

1. `yds_doctor` — 体检，缺什么会明说（settings.json 缺 yds.* 键让用户补）。
2. `yds_build` — 从零构建 yms-home（首次下载 77MB kernel，约 19 分钟；之后约 1 分钟）+ 拉配置。
3. `yds_start` — 后台启动（socks 转发器/配置缺失自动补，幂等）。输出 rdbga cookie 值。
4. `yds_status` / `yds_logs` — 观察就绪（`/_yms/ready` → running；真实库首启 1–2 分钟）。
5. `yds_stop` 停止。

## 调试（JDWP 断点）

- `yds_ide apply` 写 ris-ide 程序配置前，若 `.dsh-ris-ide/config.json` 不存在，先按 ris-ide 的结构初始化（`version/defaults/programs`）；条目名不叫 `yds-yms-*`，而是 **java=parent.artifactId、前端=package.json 平级 module.xml 的 module.name**（老名字会被识别并就地改名，不留重复行）。
- ide 条目必须 `kind: "spring"` 才能被 ris_dev_debug 识别（manual 条目会报「只有 Spring(Java) 程序支持调试」）——`yds_ide apply` 生成的条目已带；自定义 startCommand 优先于默认 spring 启动路径，调试走 `${JDWP_ARGS}` 占位符替换，行为不变。

`yds_ide {action:"apply"}` 把 `yds-yms-<module>` 条目写进 `.dsh-ris-ide/config.json`
（startCommand 含 `${JDWP_ARGS}` 占位符，仅 upsert 自己的条目，不碰用户其它条目）→
之后 `ris_dev_debug` 断点调试 / `ris_dev_start` / `ris_dev_stop` 走 dsh-ris-ide 的标准启停（日志进 logs/）。

**同时生成 `.vscode/launch.json`**（写在**项目根**——即含 `.vscode/settings.json` 的目录、
IDE 实际打开的文件夹，不是 DSH 会话 workspace 根；与 YonCode 的 `ensureLaunchConfig`
同名同构条目 `yms-middleware-cloudnative-jdk-21`）：YonCode 端 F5 也能直接启动/调试 YMS 中间件，
两边写入互不冲突（同名条目、只 upsert 自己那条）。该条目的 vmArgs 含
`-Dapp.metainfo.start_mode=static`（**关键**：服务发现改读 `config/ip_node_mapping.json`
而不是 eureka——开发机到不了内部 k8s registry；实例不可达时 IrisInvoker 再回退
`domain.url` 云调试改写走公网 WAF）、`-Dyms_fetch_config_version=2.0.0`、
`-Dyms.bootstrap.enableNewConfig=true`、`-Dinotify_enable=false`，以及完整的
Java 21 add-exports/add-opens 集（少一条 add-opens 就会让 Liberty JNDI 初始化失败、
模块部署 fatal）。`yds start` 的 JVM 参数与之保持一致。

**构建日志可追踪**：ris_dev_start 的 startCommand 走 `yds start --foreground`——启动前
若 yms-home 未构建会自动跑 mvn，**mvn 全部输出与各阶段进度（`[yds] …` 行）流式写进
ris-ide 的日志文件**，用 `ris_dev_logs` / `yds_logs` 实时追踪（首次构建约 19 分钟、
kernel 缓存后约 1 分钟）。启动序列：mvn 构建 → confcenter 配置 → SOCKS 隧道预检 +
转发器 → Liberty 前台启动。

**SOCKS 隧道预检**：转发器启动前先做一次 SOCKS CONNECT 探测；隧道不可用（远程开发机
出口失效）时快速失败并给出明确提示，而不是等到模块部署 20 秒后报
`数据源无法访问数据库`。隧道是瞬时故障时稍后重试即可。

**内网端点全覆盖（yonbip 隧道化）**：SOCKS 模式下除了 DB/Redis，yonbip_config.json 里的
RFC1918 内网端点（kafka 6880 / ES 6888 / license 30001 等，端口≥1024）也自动改写成
`127.0.0.1:<同端口>` 并加入转发器目标。例外（均为平台侧限制，改写无意义）：
`*.inner-yonbip-k8s.com` 域名（SOCKS 服务器解析不了 k8s 内部 DNS，保持原值+警告）、
端口<1024（本地无权限监听）。适配逻辑升级用 `.dsh-ris-yds/adapt-version` 戳标记，
版本不符时 `yds start` 自动从缓存重新适配（无需删文件）。

## API 调试

- 本地直连：`YYCToken` 头，`yds_token {url}` 生成（URL 绑定宽松，根 URL token 可打任意路径）。
- 浏览器路径：在 workbenchUrl 域下种 cookie `rdbga=<yds_start 输出的 base64>`，
  请求 `/<module>/**` 会经平台网关路由回调到本地实例（会话上下文透传，网关会剥掉 `/<module>` 前缀）。
- **`rdbga` 必须唯一且非空**：YonCode 内置浏览器启动时可能写一个空值 host-only `rdbga`，
  它的优先级高于带点域名的正确值 → 网关判定「非调试请求」，全转远端 pod：页面正常、本机
  `logs/access.log` 空、断点不进，**故障完全静默**。先 `yds_browser {action:"status"}` 看（会打印期望值和来源），
  再 `yds_browser {action:"fix"}`：fix **默认 dry_run=true 只预览**，确认计划后用 `dry_run:false` 真写
  （删空值/重复/不匹配，写入期望值）；CLI 对应 `yds browser fix [--rdbga=<值>] [--dry-run]`。
  期望值默认按项目配置算（`module,/context@bind:port` 的 base64）；运行中 JVM 的 `-Drdbga` 只用于校验，
  所有运行实例的值都与配置不一致时**拒绝写入**并要求 `--rdbga` 指定（别把浏览器指向不存在的实例；
  同机还有别的项目 JVM 时直接 `--rdbga` 最稳）。`yds start` 成功后会自动校准一次
  （后台/前台/已在运行都会尝试，浏览器没开 DevTools 端口就跳过）。
- 业务接口 302 且日志里出现 `【yht_access_token_invalid】` / `YmsContextFilter [processOnUnLogin]`：
  那是**会话**问题（不是代理/回调），控制器根本没执行；用已登录的工作台页签发请求，别用干净上下文。
- `POST /CloudRemoteCall/<接口全名>/<方法名>` 为 YMS RPC 形态。

## 代理（SOCKS）与端口归属

- `yds start` 前会做 SOCKS 预检（握手 + CONNECT 探测目标），隧道不可用会**快速失败**并给出原因，不会白等模块部署 2 分钟。
- 隧道优先借 dsh-ris-ide 的引擎（`yds_proxy sync|status`），`127.0.0.1:1521/6890/6880/6888/30001` 由它绑定；未装 ris-ide 才回退内置转发器——**不要手动再起第二套**，会抢端口。
- 引擎随 `dsh` 退出停止（宿主钩子），也可 `yds proxy stop` 手动停；配置与 pid 在 `~/.dsh-ris-ide/`。
- `yds proxy sync|start` 会把 SOCKS 参数写进 `.vscode/launch.json` 的 yds 条目（YonCode/VS Code F5 启动的 java 才走代理），`yds proxy stop` 自动摘掉——只动自己那条 configuration。
- 引擎与配置**全机一份、整机生效**：`~/.dsh-ris-ide/proxy.json`（`DSH_RIS_IDE_PROXY_HOME` 可改）。规则不分工作区/会话（`workspace` 只是来源标注）；`yds_proxy sync` 只替换 `source=yds` 的行，用户自己的规则不受影响；yds 只写真实程序：`java`（内网 /24 整段、任意端口——JDBC/Redis 驱动不支持 SOCKS，只能靠系统层拦截）+ `git`（git.url 的主机）+ 带 `label` 的 `YonCode java`/`YonCode git`（`<YonCode>/devkit/*/bin/java.exe` 与系统 git，路径在项目外、项目配置推不出来，界面上显示 label）。端点不生成规则行（老的 `jdbc` 名字匹配不到任何进程）；ProxyBridge 不可用时的 `127.0.0.1` 同端口兜底监听写在配置的 `shadows` 字段里，属于引擎输入、不进界面。
- **主路是 ProxyBridge**（系统层按进程拦截）：`yds start` 发现隧道可用就自动启动它（提权走系统弹窗），`yds stop` 自动停止并清 git 代理；它没跑时注入与 127 映射自动当后备。手动入口 `yds proxy redirector [status|sync|start|stop]`。
- git 走 git 自身配置（`http.https://<host>/.proxy`），命令上不需要 `-c`；用 `yds proxy git-on|git-off` 控制。
- 相关工具：`yds_proxy`；相关 CLI：`yds proxy ...`。
- 浏览器 cookie 体检/校准：工具 `yds_browser`（fix 默认 dry-run），CLI `yds browser [status|fix|debug|stop] [--rdbga=<值>] [--dry-run] [--url=<页面>] [--port=<9222>]`；`debug` 起独立 profile 的调试浏览器（自动加载扩展、开 CDP），`stop` 只停自己起的；DevTools 端口清单的单一来源是 `lib/browser.js` 的 `DEVTOOLS_PORTS`（当前 9222/9223/9224/9333），不要另抄一份。

## 前端调试（本地 extend 脚本）

- 远端页面加载的是平台的 `extend*.min.js`；本地 webpack dev server（`npm run debug:extend`，默认 3004）
  要接管它，三条路：
  1. `yds fe extension` → 生成「ris-yds-extension」扩展目录（默认 `<workspace>/.dsh-ris-yds/dev-extension`），
     让用户在 `chrome://extensions` 开开发者模式后「加载已解压的扩展程序」选该目录。扩展做两件事：
     给本模块 `/…/**` 请求加 `rdbga` 头（网关按它把请求路由到本机）、把远端 `extend*.min.js|css` 换成
     `http://127.0.0.1:<fe.port>/static/…`。所有值由扩展向 `GET /dsh-ris-yds/dev-config?workspace=…`
     动态拉取（每 2 分钟 + 弹窗「立即同步」），所以端口/工作区/rdbga 变化不用重装，插件升级也基本跟随；
     扩展自身文件（manifest/sw.js）变化时只在扩展页点一次「刷新」。`--force` 重新生成，`--dir` 改目录，
     `--dsh-port` 改回连的 DSH 端口（默认 3080）。
  2. `yds fe plan` → 拿到 `{match, replace, regex, substitution}` 七条；**你自己就能用 CDP 注入**：
     `Fetch.enable` 后对每个 `Fetch.requestPaused`，URL 命中 `regex` 就
     `Fetch.continueRequest({ requestId, url: 展开替换后的地址 })`，其余 `Fetch.continueRequest({ requestId })`。
  3. `yds fe url <页面>` → 直接给带 `scriptUrl=http://127.0.0.1:<fe.port>/static` 的地址，零配置。
- 浏览器不允许网页直接安装扩展：`extension` 只生成目录，安装要用户点一次（或用支持 `--load-extension`
  的专用浏览器启动方式）。
- 控制台/概览入口：`GET /dsh-ris-yds/extension?workspace=…` 返回目录与步骤，`POST` 同路径生成目录，
  `GET /dsh-ris-yds/extension-page?workspace=…` 是一个可直接打开的说明页（ris-ide 概览里若要嵌入，
  用这个 URL 即可，无需复制 HTML）。
- 模块名/工作台主机/前端端口都来自项目配置（项目配置里的前端端口 可改），**不要硬编码 c-ass-kk-hans / srmdev 主机 / 3004**。
- Resource Override 扩展（旧方案）已从插件移除：不要再生成 `resource-override-rules.json`、不要引导用户装第三方扩展。

## YonCode 网卡 IP 校验
- `yds doctor` / `yds yoncode` 检查 YonCode 的 `serverBindAddress` 校验是否已降级为告警；`unpatched` 时**先问用户**（这是改别人的安装目录），同意后 `yds yoncode patch`，需要写 Program Files 就先说明要提权（管理员 / danger-full-access）。
- `yds yoncode revert` 从 `.bak` 还原；YonCode 升级重写文件后需重跑 patch。

## 硬约束/口径

- 项目源码只读；写只发生在 yms-home（YonCode 同构的标准部署布局）、`.dsh-ris-yds/`、`.dsh-ris-ide/config.json`（只 upsert 自己那一条）、项目根的 `.vscode/launch.json`（同样只 upsert 自己那条 `yms-middleware-cloudnative-jdk-21`，与 YonCode 生成物同名同构；其余 configuration 与注释/尾逗号原样保留——YonCode 自己每次启动也写这个文件）。唯一的浏览器侧写入是工作台域下的 `rdbga` cookie（只此一个名字、只在该域；失败静默，`--dry-run` 可先预览）。
- 进程身份校验：stop/状态只认 pidfile 里「经 /proc cmdline 验证是本工具进程」的 pid，pid 复用/重启后的陈旧 pidfile 自动清理，绝不误杀无关进程。
- 启动失败自动回滚：startDetached 端口 120 秒未就绪即报错并回收（TERM+pidfile 清理），SOCKS 转发器随之停止，不留孤儿进程。
- 前台模式（ris_dev_start）同样写 pidfile——`yds_status`/`yds_stop` 对 IDE 启动的实例可见；前台输出里也打印 rdbga cookie 行。
- `yds_logs` 只读日志尾部（≤256KB）；yms-console.log 超过 16MB 自动轮转为 .old。
- CLI 未知命令/动作、多余参数/未知选项、执行失败都**非 0 退出**；agent 工具结果带 `ok` 字段（失败 `ok:false`），先看 `ok` 再解析文本。
- JDBC 适配支持 oracle @//service、oracle SID、mysql 三种形态；无法识别的 jdbc url 会打警告（不重写不转发）。
- 安全边界（用户已决策文档化）：workbenchUrl 是项目级信任根（勿对不可信仓库跑 build/start）；SOCKS 转发器本机无鉴权；`yds token` 明文输出（调试用途）；Windows 停机为硬杀（无优雅 TERM）；`yds browser fix` 会删/写用户浏览器的 `rdbga` cookie（仅工作台域、仅此名字、失败静默；不确定先 `--dry-run`）。
- 与 YonCode 共用工作区时：YonCode 的 sync 会把 yms-home/config 覆盖为远端原始地址（直连场景正好）；
  SOCKS 场景重跑 `yds_confcenter` 即可（幂等秒级）。
- git 只读（`git.commit=never`），clone 走 `git -c http.proxy=socks5h://<socks>`（仅当配置了 SOCKS）。
- 模块名从 yonbuilder.json/module.xml 自动识别，不要手工写死。

## ris-ide 只做外挂（监听，不改它）

- `yds ide apply` 注入 `id: yds:<项目名>` 的启动器行 + 按 `module.xml`/pom 修正 yds 项目的行名 + 禁用被启动器取代的后端行。
- 然后插件在宿主里监听 `.dsh-ris-ide/config.json`（`fs.watch` + 2s 轮询、400ms 去抖）：ris-ide 初始化/刷新配置把条目冲掉时自动补回，其它行原样保留。登记在 `~/.dsh-ris-ys/ide-watch.json`…实际路径 `~/.dsh-ris-yds/ide-watch.json`。
- 不要为了联动去改 dsh-ris-ide（用户口径：ris-yds 不能影响 ris-ide 的使用）。
- `yds yoncode patch` 除了去掉网卡校验，还会给 YMS 的 vmArgs 注入 `-DsocksProxyHost/-DsocksProxyPort`（java 不再走 ProxyBridge：WinDivert 会把 Oracle TNS 握手 reset）；`.env proxy.javaRules=on` 可恢复 java 代理规则。
