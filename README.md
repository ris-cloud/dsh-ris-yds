# dsh-ris-yds

YonBIP YDS 客开后端的本地运行时，做成 DSH 插件 + CLI 双形态：

- **DSH 插件**：给 coding agent 提供一整套 `yds_*` 工具（doctor / config / token / confcenter / build / start / stop / status / logs / ide / proxy / browser / fe / yoncode）。
- **CLI**（`bin/yds.js`，装包后 `yds` 命令）：同一套实现给人用，也是 dsh-ris-ide 程序条目的 startCommand。

本地起服务 = 在 `yms-home` 里启动 YMS（WebSphere Liberty）容器——应用 WAR 部署在容器中，
平台配置来自 confcenter，DB/Redis 可直连或经 SOCKS 代理（本地端口转发），网关回调走 rdbga。

## 安装（DSH）

```bash
# 公开 npm（推荐）
dsh plugin --profile web add dsh-ris-yds

# 或从本地 checkout 安装（开发调试）
dsh plugin --profile web add <本目录>
# 之后新会话里 agent 就有 yds_* 工具；skills/dsh-ris-yds 会自动同步到项目 .dsh/skills
```

装完需**重启 `dsh web`**（宿主插件只在启动时组合一次，工具注册才生效）。

## 与 dsh-ris-ide 的关系：外挂，只读 + 监听

ris-yds **不改 dsh-ris-ide 的任何代码**，也不要求它知道我们的存在。

1. `yds ide apply` 往 ris-ide 的 `.dsh-ris-ide/config.json` 注入一条启动器条目
   （`id: yds:<项目名>`，命令是 `node <插件>/bin/yds.js start --foreground --jvm-args "${JDWP_ARGS}"`），
   并按项目文件修正 yds 项目的行名、禁用被启动器取代的后端行。
2. 注册工作区后，插件在 dsh 宿主里**监听该文件**（`fs.watch` + 2 秒轮询兜底，400ms 去抖）：
   ris-ide 初始化或点击「生成/刷新配置」重写文件、把我们那条冲掉或把名字改回去时，自动补回并重命名。
   其它行原样保留，ris-ide 的配置语义（合并/删除规则）不受影响。

```bash
node bin/yds.js ide apply     # 注入 + 开启监听
node bin/yds.js ide remove    # 移除条目 + 关闭监听
```

监听登记在 `~/.dsh-ris-yds/ide-watch.json`（机器级，多工作区）；ris-ide 未安装或未初始化时什么也不会发生。
监听只在宿主进程里跑（`dsh web` 启动时加载），所以改完插件代码需重启 dsh web 才生效。

## CLI 用法

```bash
yds doctor        # 体检：配置解析、yms-home/进程/端口/socks 转发器、缺失项
yds config        # 生效配置（键值+来源，凭据打码）
yds token <url>   # 生成 YYCToken（API 调试用）
yds confcenter [--offline]   # 拉取/适配 confcenter 4 配置文件进 yms-home/config
yds build         # 从零构建 yms-home（首次 ~19min 下载 kernel；缓存后 ~1min）
yds start [--jvm-args "..."] # 后台启动（幂等；socks 转发器/config 缺失自动补）
yds stop [--keep-socks]
yds status
yds logs [--lines 200]
yds ide apply|check|remove   # 维护 .dsh-ris-ide/config.json 条目 + .vscode/launch.json 条目
                             # config.json 不存在时先按 ris-ide 的格式初始化（version/defaults/programs）
                             # 条目名：java 项目 = bootstrap pom 的 parent.artifactId（如 c-ass-kk-hans）
                             #         前端项目 = package.json 平级 module.xml 的 module.name（如 c-ass-kk-hans-fe）
yds proxy [status|sync|start|stop|git-on|git-off]   # 借用 dsh-ris-ide 的代理引擎（见下）
yds proxy redirector [status|sync|start|stop]       # ProxyBridge 系统层拦截（随 start/stop 自动启停，这里是手动入口）
yds browser [status|fix] [--rdbga=<v>] [--dry-run]  # 工作台浏览器 rdbga cookie 体检/校准/预览（空值会把请求全路由到远端）
yds fe [rules|plan|url <page>]                      # 前端调试接入（扩展规则 / CDP 改路 / scriptUrl）
```

## 前端调试：让远端页面加载本地 extend 脚本（`yds fe`）

yds 页面从平台加载 `/<module>/…/javascripts/extend*.min.js`，本地开发要换成
`http://127.0.0.1:<fe.port>/static/…`。三条路，规则里的**模块名、工作台主机、前端端口全部取自当前项目配置**
（`yonbuilder.json`/已部署模块、`yds.workbenchUrl`、`.vscode/settings.json` 的 `yds.webConfig[*].yds.localDevUrl`），不写死。

```bash
yds fe rules    # 生成 <workspace>/.dsh-ris-yds/resource-override-rules.json（7 条，可直接导入扩展）
yds fe plan     # 同样 7 条规则换成「正则 + 替换」，给 agent 用 CDP 注入
yds fe url <页面>  # 给页面追加 scriptUrl=http://127.0.0.1:<dev端口>/static（零配置）
```

1. **Chrome 扩展 Resource Override**（`yds-chrome-resource-override.crx`）：扩展里 Import 上面那个 JSON。
2. **不装扩展**：用 `yds fe plan` 的 `{regex, substitution}`，在浏览器里开 CDP `Fetch` 拦截，
   `Fetch.requestPaused` 命中则 `Fetch.continueRequest({ requestId, url: substitution 展开 })`。
3. **零配置**：`yds fe url` 出来的地址直接打开，前端自己会去加载 `scriptUrl` 指向的 `/static`。

**不需要 .env 配置**：前端端口取自项目 `.vscode/settings.json` 的 `yds.webConfig`（`yds.localDevUrl`）；该键不存在时回退到前端工程目录里的 `resource_override_rules.json` 所写的端口，再回退 3004。Chrome 扩展安装包随插件发布（`assets/yds-chrome-resource-override.crx`），不依赖本机路径。

## 代理参数写进 launch.json，代理停就还原

在 dsh 里启动的进程能用环境变量直接指向 SOCKS；**YonCode/VS Code 自己 F5 启动的 java**
我们拦不到，但它读 `.vscode/launch.json`——所以 `yds ide apply`（以及 `yds proxy sync|start`，
当该条目已存在时）会把这几项写进我们那条 `yms-middleware-cloudnative-jdk-21` 的 vmArgs：

```
-DsocksProxyHost=<.env socks.host>
-DsocksProxyPort=<.env socks.port>
-Djava.net.useSystemProxies=false
```

`yds proxy stop` 会把它们摘掉（条目其余内容恢复成规范形态，用户的其它 configuration 一个字节
都不动），避免下次 F5 时 java 指向一个已经死掉的本地端口。JDBC 不受此影响：驱动不认 SOCKS，
仍然只能靠 `127.0.0.1` 同端口映射。

## 不装 dsh-ris-ide 也能用（内置转发器）

本插件不依赖 dsh-ris-ide：

- **有 SOCKS**（`.env` 的 `socks.host/port`）且装了 dsh-ris-ide → 借用它的代理引擎（规则在它的 🌐 面板里
  可见、可编辑，全机一份）；
- **没装 dsh-ris-ide** → `yds start` 与 `yds proxy sync|start` 自动回退到随包发布的
  `lib/socks.js` 内置转发器（`yds proxy status` 会显示「内置转发器: 运行中」，`yds proxy stop` 一并停掉）；
- **没有 SOCKS** → 直连模式，不需要任何隧道（见下节）。

`yds proxy git-on|git-off` 只改 git 配置，不依赖引擎。

### 反过来：需要 IDE 能力时装 dsh-ris-ide（可选）

本插件只负责 YonBIP/YMS 运行时（YMS 起停、配置、YonCode 补丁、代理规则）；要在同一个 dsh 里
**启停 Spring Boot / 前端 dev server、看实时日志、用 JDWP 断点调试**，装
[`dsh-ris-ide`](https://gitee.com/riscloud/dsh-ris-ide) 即可。两者互不依赖：
`yds doctor` 会发现缺少借用引擎并提示一次（`未检测到 dsh-ris-ide（可选）`），同时自动使用内置
socks 转发器，**功能不受影响**；装上之后 `yds proxy sync` 会改用它，两边共用同一份规则表与引擎。

## YonCode 直连（不用代理）

`.env` 不写 `socks.host` 就是直连模式，YonCode 端可以完全不用代理栈：

| 环节 | 直连模式下的行为 |
|---|---|
| confcenter | 配置里的 DB/Redis 地址原样保留（不改写成 `127.0.0.1`） |
| `yds start` | 不起内置转发器、不找 dsh-ris-ide 引擎、不启 ProxyBridge、不写 git 代理 |
| `yds ide apply` | 生成的 `.vscode/launch.json` **不带** `-DsocksProxyHost/-DsocksProxyPort`（F5 的 java 直连内网） |
| `yds yoncode patch` | 只把网卡校验改成告警；`.env` 没有 socks 时不注入 JVM 代理参数（也可显式 `--no-socks`） |

从代理模式切到直连：删掉 `.env` 里的 `socks.*` → `yds confcenter --offline`（重写直连配置）→
`yds ide apply`（重写 launch 条目，摘掉代理参数）→ YonCode Reload Window。

### 同一台机器：dsh 走 SOCKS、YonCode 直连（`ide.launch=direct`）

不给 YonCode 配代理、但 dsh（WSL）仍需要隧道时，用 `ide.launch=direct` 把两种模式**物理隔离**，
而不是复制整套 yms-home：

```ini
# .env —— socks 保留给 dsh，YonCode 的 F5 走直连
socks.host=10.3.91.121
socks.port=1080
ide.launch=direct
```

```bash
yds confcenter          # 写两份：config/（127.0.0.1 适配，给 dsh）+ config-direct/（原始地址，给 YonCode）
yds ide apply           # launch 条目改为 -Dlocal_conf_path=<ymsHome>/config-direct/，且不带任何 socks 参数
yds yoncode patch --no-socks   # 或直接 patch：direct 模式下默认不再注入 JVM 代理参数
```

| | `ide.launch=proxy`（默认） | `ide.launch=direct` |
|---|---|---|
| YonCode JVM 参数 | `-DsocksProxyHost/-DsocksProxyPort` | 无代理参数；有 socks 时加 `-Dlocal_conf_path=<ymsHome>/config-direct/` + `-Dyms_use_local_conf=true` |
| YonCode 读的配置 | `yms-home/config`（127.0.0.1 映射） | `yms-home/config-direct`（原始地址）；没有 socks 时就是 `config` |
| `yds confcenter` 写 | 只写 `config/` | 同时写 `config/` 与 `config-direct/`；没有 socks 时删除 `config-direct/` |
| `yds yoncode patch` | 注入 JVM 代理参数 | 不注入（`--no-socks` 行为，成为默认） |

两种模式**不会互相串**：launch 条目每次由 `yds ide apply` 整体重写（切回 proxy 会移除
`local_conf_path`），配置目录按模式分开写，`yds confcenter` 在没有 socks 时会主动删掉过期的
`config-direct/`。`yds ide apply` 的输出里有一行 `launch 模式: …` 说明当前生效的是哪一套。

## 引擎生命周期：随 dsh 退出停止

引擎是 detached 的（要跨 dsh 重启存活、且全机共享一份），但 dsh 退出时由宿主钩子停掉它并释放
`127.0.0.1` 端口——否则关掉 dsh 后这些端口会一直挂着没有主人。`dsh` 崩溃时下一次启动按 pidfile
身份校验清 stale，`yds proxy stop` 也可手动清。

## YonCode 的 serverBindAddress 校验（`yds yoncode`）

YonCode 要求 `yds.serverBindAddress` 是本机网卡 IP，否则拒绝启动（`Invalid IP address, no
interface found with address …`）。本插件的运行方式恰恰是把回调地址写成 NAT/端口转发/WSL
外的地址，所以这个校验必须降级为告警：

- `yds yoncode`（status）——检测安装位置与状态：`patched` / `unpatched` / `unrecognised`
  （不认识的版本不猜）/ `absent`（没装，正常）；安装目录可用 `.env` 的 `yoncode.home`
  或环境变量 `YONCODE_HOME` 指定，指定了就**只**看这一处。
- `yds yoncode patch`——把 `throw` 换成 `console.warn`，先写 `extension.js.bak`；
  幂等；写不动时报"需要管理员或 danger-full-access"，不会静默失败。
- `yds yoncode revert`——从 `.bak` 还原原文件。
- `yds ide apply`（生成 `.vscode/launch.json` 与 `.dsh-ris-ide` 条目）时会**自动检查**，
  未打补丁就在输出末尾提示；`yds doctor` 也有一行 `yoncode: …`。
- 只改 YonCode 自己的文件，不碰项目；YonCode 升级会重写该文件，重跑一次 patch 即可。

## YonCode 补丁：网卡校验 + JVM 级 SOCKS

`yds yoncode patch` 对 YonCode 的扩展包做两处修改（同一份 `.bak`，`yds yoncode revert` 一起还原）：

1. 把 serverBindAddress 的网卡校验从 `throw` 改成告警——回调地址是外网映射 / NAT / 端口转发时不会再有
   `Invalid IP address, no interface found with address`。
2. 在 YMS 的启动 `vmArgs` 里追加 `-DsocksProxyHost=<socks.host> -DsocksProxyPort=<socks.port>`。

第 2 条是为了绕开 ProxyBridge：WinDivert 重定向能连上 Oracle，但 TNS 握手第一个包会被 reset
（`T2C7Oversion.doOVERSION` → `SQLRecoverableException: Connection reset by peer`），YMS 因此起不来。
JVM 自己走 SOCKS 时是普通 TCP（和 WSL 侧一直正常的路径一致）。

所以 java 默认**不再**由 ProxyBridge 拦截（规则里没有 `*java*`）；确实需要系统层覆盖其它 java 进程时，
在 `.env` 里写 `proxy.javaRules=on` 再 `yds proxy sync`。git 仍由 ProxyBridge + `git config` 双保险。

## 代理规则的有效性

一条规则要真正生效，必须**同时**满足：已启用 + 有程序 + 有 IP + 有端口。「任意端口 / 任意主机」要显式写 `*`；空白不再被当作「全部」，半成品行会被跳过（其余插件会在界面上标红）。`yds proxy sync` 生成的 4 条规则（java / git / YonCode java / YonCode git）一律带 `ports: '*'`。

## 系统层拦截（ProxyBridge）：覆盖我们自己不启动的程序

`yds start` 会顺带**启动** ProxyBridge（提权走系统弹窗：Windows UAC / Linux 免密 sudo），
`yds stop` 顺带停止它并清除 git 代理——三层（本地引擎、系统层拦截、git 配置）共用一个生命周期。
它按**进程名**在系统层改路，
所以 Navicat、IDE 里的 java、终端里的 git 都能覆盖；`127.0.0.1` 同端口映射与启动注入只是
它没跑时的后备。启动需要 root（Linux eBPF）/ 管理员（Windows WinDivert），CLI 不会替你提权。

```bash
yds proxy redirector status   # 本侧与 Windows 侧是否可用、版本、profile 是否已导出
yds proxy redirector sync     # 导出 ~/.dsh-ris-ide/proxybridge/dsh-ris-ide.pbprofile + 启动命令
```

vendor 目录（插件自带、无需安装）：`~/.dsh-ris-ide/proxybridge/vendor/linux/`（ProxyBridge +
libproxybridge.so）、`vendor/windows/`（ProxyBridge_CLI.exe + Core.dll + WinDivert.dll +
WinDivert64.sys，portable 形态）。WSL 与 Windows 是两个独立进程，各用各的 profile。

## 代理：借用 dsh-ris-ide 的引擎，而不是自己再起一套

一台机器只能有一个进程绑 `127.0.0.1:1521`。所以 `yds start` 不再默认起自己的
`socks-forward.js`，而是**优先借用 dsh-ris-ide 的代理引擎**（`lib/proxy.js`，与控制台
🌐 弹窗同一份配置、同一个进程）：

1. 从 confcenter 缓存解析出 DB / Redis / 内网端点（kafka、ES、license）；
2. 生成 `source: 'yds'` 的规则写入**全机共享的** `~/.dsh-ris-ide/proxy.json`（`DSH_RIS_IDE_PROXY_HOME`
   可改位置）——只替换 `source=yds` 的行，其它用户/IDE 的行原样保留。规则**只写真实程序**：
   - `java`（内网 /24 整段、任意端口）+ `git`（走 `git.url` 的主机）——覆盖面板外启动的常用工具；
   - `YonCode java` / `YonCode git`（带 `label`，界面上直接显示来源）：YonCode 用的是它自带的
     JDK（`<YonCode>/devkit/*/bin/java.exe`，版本目录用 `*` 通配，升级不失效）和系统 git，
     路径都在项目外，项目配置推导不出来，所以单独按路径拦截；
   端点本身**不生成规则行**（程序名不存在的东西匹配不到进程）；
3. 确保引擎在跑（规则变则重启，否则幂等）；ProxyBridge 没跑时引擎在 `127.0.0.1:<同端口>`
   上起兜底监听（Oracle/Redis/kafka/ES/license 五个端口，全部由端点推出、无需手写），这些
   监听写在代理配置的 `shadows` 字段里（引擎输入），**界面里不显示**；ProxyBridge 跑起来后
   `shadows` 为空、一个端口都不绑；
4. 写 git 代理（**两侧都写**）：`git config --global http.https://<克隆URL主机>/.proxy socks5h://<socks>`。
   Windows 侧那份用 `git.exe config --global` 写进 Windows 用户的配置——Windows 的 DNS 解析不出
   `gitlab.hanslaser.com`，只有 `socks5h` 让代理端解析才连得上，YonCode/VS Code 里的 git 才不会失败。
   **不必在命令上加 `-c http.proxy`**——写进 git 配置后普通 `git` 与 dsh-git 插件都自动生效；
   只 scope 到克隆 URL 的主机，用户其它 remote 不受影响。`.env` 里 `git.proxy=off` 可关掉。

生命周期上是**一键**：`yds start` 一并拉起引擎、系统层拦截（ProxyBridge，提权走系统弹窗）、
git 配置；`yds stop` 一并停掉并清掉 git 条目（`dsh` 退出时宿主自己也会清理）。

Windows 侧的启动细节（都实测过）：GUI 安装的 `ProxyBridgeSvc` 服务与 CLI **互斥**（都抢 WinDivert
句柄），所以启动 CLI 前会先停服务（停过就记在 `proxybridge-service.json`，`stop` 时尝试恢复）；
手起/遗留的 `ProxyBridge_CLI.exe` 会先被结束再接管；CLI 没有日志开关，stdout 重定向到
`%TEMP%\dsh-ris-proxybridge.log`（插件侧按 `/mnt/<盘>/Users/<你>/AppData/Local/Temp/...` 读），
起不来时把日志尾部写进错误里。成功的样子是日志里出现
`java.exe ... -> 172.20.235.81:6890 via Proxy SOCKS5://...`。

`proxy.engine=self`（.env）可强制用内置转发器；**未安装 dsh-ris-ide 时自动回退**到
`lib/socks.js`，所以只有 dsh-ris-yds 的机器照常工作。

体量参考：引擎约 700 行（ris-ide `lib/proxy.js`，含 SOCKS 握手/影子监听/CONNECT 代理/
pid 身份校验/规则解析），本插件只加约 260 行桥接（`lib/ide-proxy.js`）负责生成规则与 git 配置。

## 配置来源（零硬编码，跨 OS）

| 来源 | 文件 | 内容 |
|---|---|---|
| 项目（只读） | `<project>/.vscode/settings.json` | `yds.workbenchUrl / accessKey / accessSecret / serverBindAddress / serverPort / env` 等 YonCode 标准键 |
| 机器（可选） | `<workspace>/.env`（键名无插件前缀） | `socks.host/port`（有则代理、无则直连）、`proxy.engine`（auto/self）、`proxy.listenPort`、`proxy.javaRules`（on/off，默认 off）、`git.proxy`（auto/off）、`git.*`、`ymsHome`、`java.path`、`maven.*` |
| 环境变量 | `YDS_SOCKS_HOST` 等 | 临时覆盖 |

设计原则：与 YonCode 共用工作区时项目文件只读；所有写操作只落在 `yms-home/`（YonCode 同构布局）、
`.dsh-ris-yds/`（状态/缓存）、`.dsh-ris-ide/config.json`（仅 upsert 自己的条目）和项目根的
`.vscode/launch.json`（仅同名条目）。唯一的浏览器侧写入是工作台域下的 `rdbga` cookie（`yds browser fix`：
只此一个名字、只在该域、失败静默跳过）。

## YYCToken

token 由捆绑的 `native/yds-rust.<platform>-<arch>.node`（6 平台全覆盖）生成，
密钥派生在原生模块里，凭据来自 settings.json——新环境无需 YonCode。

## JDWP 调试

`yds ide apply` 会把 startCommand（含 `${JDWP_ARGS}` 占位符）写进 dsh-ris-ide 程序配置
（文件不存在时先初始化成 ris-ide 自己生成的那种结构，条目名取 `parent.artifactId`，而不是我们内部的
`yds-yms-*` 名字；老名字会被识别并就地改名，不会出现重复行），
之后用 `ris_dev_debug` 断点调试、`ris_dev_start/stop` 标准启停。

同一次 apply 还维护 `.vscode/launch.json` 里的 `yms-middleware-cloudnative-jdk-21` 条目
（与 YonCode `ensureLaunchConfig` 同名同构）：YonCode 端 F5 可直接启动/调试 YMS 中间件，
两边写入互不冲突（只 upsert 同名条目，其它 configuration 原样保留，含注释/尾逗号的文件
按 JSONC 读取）。vmArgs 含 `-Dapp.metainfo.start_mode=static`（服务发现走
`config/ip_node_mapping.json` 而非 eureka）与完整 add-exports/add-opens 集。

## 工作台浏览器的 rdbga cookie（`yds browser`）

网关只把请求路由到本机 YMS 的条件：浏览器带着 `rdbga` cookie，且值等于当前 JVM 的 `-Drdbga`。

这个条件很容易被打破，且**失败是静默的**——页面照常工作（请求被转发到远端 pod），只有本机
`logs/access.log` 空着、控制器断点不命中：

- YonCode 启动浏览器时写入的 `rdbga` 可能是**空值**（JVM 还没起来时就会这样）；
- 空值 cookie 是 host-only（`srmdev.hanslaser.com`），会覆盖带点域名的正确值（`.srmdev.hanslaser.com`）；
- 多个同名 cookie 时，网关读到哪个取决于客户端发送顺序。

`yds browser status` 通过 DevTools 端口读出工作台域下的所有 cookie，逐条标出「空值 / 值不匹配 / 正确」
及需要清理的数量，并打印期望值和它的来源。端口清单只有一个来源：`lib/browser.js` 的
`DEVTOOLS_PORTS`（当前 9222/9223/9224/9333）。`yds browser fix` 删除除「唯一且值正确」以外的所有
`rdbga`，必要时写入当前值；加 `--dry-run` 只打印计划（将清理几个、几个页签将写入），不动浏览器。
`yds start` 成功后会**自动校准一次**（后台/前台/已在运行都会尝试；浏览器没开 DevTools 端口就静默跳过，
不影响启动）。

期望值的优先级：`--rdbga=<值>`（命令行指定，最高）> 本插件按配置算出的值（`module,/context@bind:port`
的 base64）。运行中 JVM 的 `-Drdbga=` 只用于**校验**：与配置值一致时来源标为「运行中的 JVM」；所有运行
实例的值都与配置不一致时**拒绝写入**并提示用 `--rdbga` 指定（避免把浏览器指向不存在的实例）——所以对
YonCode 启动的实例同样准确；同机还有别的项目 JVM 时以 `--rdbga` 显式指定最稳。Windows/WSL 上查询
Windows 侧 `java.exe` 的命令行（WSL 需要 mirrored 网络或端口转发，Windows 浏览器才访问得到本机端口）。

## 已知边界

- SOCKS 模式下 DB/Redis 需本地端口转发（JVM 不吃 socksProxy 参数），由 `yds start` 自动起（`socks-fwd` 子命令长驻）。
- 浏览器调试需在 workbench 域种 `rdbga` cookie（`yds start` 输出值，前台模式也打印；`yds browser fix` 可自动校准），平台网关才会把 `/<module>/**` 回调到本地实例。
- 业务接口 302 且日志里出现 `【yht_access_token_invalid】` / `YmsContextFilter [processOnUnLogin]` 是会话问题（不是代理/回调）：用已登录的工作台页签重新签发请求即可。
- git 默认只读（`git.commit=never`）。

## 安全/健壮性设计（评审后加固）

- **进程身份校验**：pidfile 里的 pid 经 `/proc/<pid>/cmdline` 验证属于本工具（java=YMSLauncher / node=socks-fwd）才允许 stop；陈旧 pidfile 自动清理，pid 复用绝不误杀（非 Linux 平台拒绝信号陌生 pid）。
- **启动失败回滚**：端口 120 秒未就绪即报错并回收（pidfile 清理 + TERM + SOCKS 转发器停止）；socks 隧道预检（握手+CONNECT 探测）不可用快速失败。
- **原子写 + 0600**：confcenter 缓存与 yms-home/config 写入均为 tmp+rename 原子操作，凭据文件权限 0o600/目录 0o700；ip_node_mapping 解析失败先备份 `.bak-*` 再重建（不静默清空其它模块条目）。
- **JSONC 解析为字符串感知状态机**：.dsh-ris-ide/config.json 里的字符串内容（`http://`、`,]` 等）不会被注释/尾逗号剥离误伤，用户条目 round-trip 无损。
- **输出流式不缓冲**：mvn 19 分钟构建的输出直转发到 stdout（ris_dev_logs 实时可追踪），不进内存；`yds logs` 只读日志尾部（≤256KB）；console log 16MB 轮转。
- **跨 OS**：native 模块经 pathToFileURL 加载（Windows 盘符/空格路径安全）；mvn 在 Windows 走 mvn.cmd+shell；JVM 参数 split 引号感知；`--flag=true` 布尔解析；spawn 全部 windowsHide。
- **脱敏**：config/git url 输出打码 userinfo；描述符 mask accessSecret。
- **浏览器 cookie 写入范围受控**：`yds browser fix` 只碰 `rdbga` 这一个 cookie、只碰工作台域名（按 `hostname` 精确匹配——子域、`workbench.com.evil.com`、query 串里的同名字符串都不算）；写入前校验值必须是合法的 `module,/context@ipv4:port` base64，写入后回读确认「唯一且正确」否则报失败；`--dry-run` 可先预览，agent 工具 `yds_browser` 对 fix 默认 dry-run，需显式 `dry_run:false` 才真写。
- **CLI 失败非 0 退出**：`run()` 返回 `exitCode`、由 bin 落地（不在 dsh 工具进程里设 `process.exitCode`），agent 工具结果带 `ok:false`；未知命令/动作、多余参数/未知选项都在探测端口之前拒绝。

## 已知安全边界（用户决策：文档化，不做代码限制）

- **workbenchUrl 是项目级信任根**：它来自被开发仓库的 `.vscode/settings.json`，且生成的 maven settings 对 jfrog 制品 `checksumPolicy=ignore`——**不要对不可信来源的仓库执行 `yds build`/`yds start`**（理论上恶意仓库可指向伪造 jfrog 并投毒 77MB kernel）。仅对可信内网仓库使用本插件。
- **SOCKS 转发器本机无鉴权**：127.0.0.1:1521/6890 上本机任何进程都可穿隧道访问内网 Oracle/Redis。单用户开发机可接受；多用户共用主机时需自行加防护。
- **`yds token` 明文输出 YYCToken**（bearer 凭据，进 stdout/ris-ide 日志）：设计如此——调试用短期凭据，方便复制到 curl/浏览器；敏感场合自行避免落盘。
- **Windows 停机为硬杀**：win32 上 `process.kill(pid,'SIGTERM')` 即 TerminateProcess，Liberty 无优雅停机（POSIX 正常 TERM→30s→KILL）。ris_dev_stop 路线本来就是 taskkill 树杀，行为一致。
- **`yds browser fix` 会删/写用户浏览器的 `rdbga` cookie**：仅限工作台域、仅此一个名字，失败静默（不影响 `yds start`）；但它确实会改浏览器状态——不确定时先 `--dry-run` 预览，或直接看 `yds browser status`。
