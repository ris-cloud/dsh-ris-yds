# dsh-ris-yds 开发手册

本文是**实现与维护**文档：架构、模块职责、内部机制、测试与发版。面向使用者的「能做什么 /
怎么装 / 常用命令」见 [README.md](README.md)；两边不重复，机制细节只放这里。

> 本仓库约定：`README.md` 只描述能力与使用方式；具体逻辑（借用引擎、系统层拦截、配置改写、
> 外部 IDE 补丁、cookie 校准等）一律写在本文。

## 1. 定位与设计原则

- 一个包、两种形态：DSH 宿主插件（14 个 `yds_*` 工具）与 CLI（`bin/yds.js`，命令 `yds`），
  共用 `lib/` 同一套实现。CLI 也用作 dsh-ris-ide 程序条目的 `startCommand` 目标。
- 零运行时依赖：`dependencies` 为空；跨平台能力靠 `native/yds-rust.<platform>-<arch>.node`
  （6 平台，已提交二进制）与 `assets/`（浏览器扩展包）。
- 零硬编码：所有主机/端口/模块名/凭据都来自项目 `.vscode/settings.json`（只读）、
  工作区 `.env`（可选）、环境变量；写操作只落在 `yms-home/`、`.dsh-ris-yds/`、
  `.dsh-ris-ide/config.json`（仅自己的条目）、`.vscode/launch.json`（仅同名条目）
  以及工作台域的 `rdbga` cookie。
- 可选依赖 dsh-ris-ide，但不强依赖：缺它时退回随包内置的 socks 转发器；
  两个插件可各自单独安装、单独工作。

## 2. 模块地图

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/cli.js` | ~1000 | 命令分发、`yds` 全部子命令、`prepareStart` 生命周期编排 |
| `lib/config.js` | ~550 | 配置解析（settings.json / .env / env）、键表、`problems`、`describeConfig` |
| `lib/ide.js` / `lib/ide-proxy.js` | ~700 / ~680 | ris-ide 集成（launch 条目、监听）+ 代理引擎桥接（借用/回退、规则、git） |
| `lib/yms.js` | ~300 | yms-home 构建、启动/停止、pidfile 身份校验、就绪探测 |
| `lib/confcenter.js` | ~380 | 平台配置拉取与本地适配（4 文件、direct 副本、原子写） |
| `lib/browser.js` | ~430 | DevTools 端口探测、`rdbga` cookie 体检/校准 |
| `lib/socks.js` | ~260 | 内置 SOCKS 转发器（无 ris-ide 时的回退档） |
| `lib/yoncode.js` | ~250 | 外部 IDE（YonCode）扩展包兼容补丁：网卡校验降级、JVM 代理注入 |
| `lib/fe-dev.js` | ~206 | 前端调试规则生成（扩展 JSON / CDP 正则 / scriptUrl） |
| `lib/index.js` | ~267 | 宿主插件入口：`ctx.tools.register` 注册 14 个工具、skill 同步 |

约 5.4k 行，无构建步骤（纯 ESM，`type: module`，`main: lib/index.js`）。

## 3. 配置解析（`lib/config.js`）

优先级：项目 `.vscode/settings.json`（`yds.*`，只读）**高于** 工作区 `.env`，`.env` 高于环境变量。
`.env` 的键**不带插件前缀**（与 YonCode 共用工作区时同一份文件）。

| 键 | 默认 | 说明 |
|---|---|---|
| `socks.host` / `socks.port` | 空 | 都空 = 直连；有值 = 代理模式（`socks=null` 即直连） |
| `socks.dbPort` / `socks.redisPort` | 1521 / 6890 | 本机映射端口 |
| `local.ymsHome` | `<project>/yms-home` | 运行时目录（`YMS_HOME` 亦可） |
| `local.bindAddress` / `local.serverPort` | 项目 `yds.*` / 31010 | 回调地址与端口 |
| `ide.launch` | `proxy` | `proxy` / `direct`，非法值进 `problems` 并回退 `proxy` |
| `proxy.engine` | `auto` | `self` 强制内置转发器（`YDS_IDE_PROXY=none` 亦禁用借用） |
| `proxy.listenPort` | 0（自动） | 借用引擎时的 listen 端口 |
| `proxy.javaRules` | off | `on` 时让系统层拦截也覆盖 java 进程（默认不覆盖，见 §6.4） |
| `git.proxy` / `git.url` / `git.token.*` / `git.commit` | auto / 空 / 空 / `never` | git 代理与只读约束 |
| `maven.repo` / `maven.settings` | 空 | 构建 yms-home 用（默认 settings 会被内网 mirror 劫持时显式指定） |
| `yoncode.home` | 空 | 外部 IDE 安装目录（`YONCODE_HOME` 亦可） |

派生字段：`configDir = <ymsHome>/config`、`configDirectDir = <ymsHome>/config-direct`、
`launchMode`。`describeConfig()` 打印生效键值+来源（凭据打码），`problems[]` 收集非法值。

## 4. 平台配置管线（`lib/confcenter.js`）

- 从 confcenter 拉 4 个文件：`yonbip_config.json`(~89KB)、`yms_middleware.json`(~208KB)、
  `module_config.json`(269B)、`ip_node_mapping.json`(~18KB) + `variables/default.properties`。
- 适配：DB/Redis 地址改写成 `127.0.0.1:<dbPort/redisPort>`（仅 socks 模式）；
  `ip_node_mapping` 合并本机模块条目（解析失败先备份 `.bak-*` 再重建，不清空其它模块）；
  写 `adapt-version` 与 variables。
- 写入：`adaptAndWriteConfig(cfg, files, { rewrite = true, dir = null })`，`dir` 缺省
  `<ymsHome>/config`；tmp+rename 原子写，目录 0o700 / 文件 0o600。
- **直连副本**：socks 配置时同时写 `config-direct/`（`rewrite:false`，原始地址）；
  无 socks 时 `rmSync(configDirectDir)` 删过期副本。只有 `ide.launch=direct` 读它。
- 缓存：`.dsh-ris-yds/confcenter/`，`--offline` 用缓存（网络不可达时启动依赖它）。

## 5. 构建与启动（`lib/yms.js`）

- `yds build`：从零构建 `yms-home`（首次从 jfrog 下 ~77MB kernel，约 19 分钟；缓存后约 1 分钟）。
  用 `mvn -s <maven.settings>`（默认 settings 的 riscloud mirror 会劫持 central）；
  JDK 由 `.env` 的 `java.path` / `maven.*` 指定，否则 PATH。
- 启动：`yms-home/bin/startup.sh` 里 `YMS_USE_LOCAL_CONF="-Dapp.metainfo.start_mode=static
  -Dlocal_conf_path=${YMS_HOME_DIR}/config/ -Dyms_use_local_conf=true"`——这就是
  「另指配置目录」的机制，也是模式隔离（§7）能只复制配置、不复制 yms-home 的依据。
- JVM 参数：引号感知 split；`--jvm-args` 透传；`${JDWP_ARGS}` 占位符由 ris-ide 调试启动替换。
- 就绪：等端口 120s（含 `/ _yms/ready` 探测），失败回滚（清 pidfile + TERM + 停转发器）；
  启动前做 socks 握手 + CONNECT 预检，不可用快速失败。
- 停止：pidfile 经 `/proc/<pid>/cmdline` 身份校验（java 认 `YMSLauncher`、node 认 socks-fwd）
  才发信号；陈旧 pidfile 清理，pid 复用不误杀；POSIX TERM→30s→KILL，Windows 直接 taskkill 树杀。

## 6. 内网访问子系统

### 6.1 三档选择（`lib/ide-proxy.js`）

1. **借用 dsh-ris-ide 引擎**（默认）：`loadIdeProxy(cfg)` 依次尝试
   `YDS_IDE_PROXY`、`<ws>/node_modules/dsh-ris-ide/lib/proxy.js`、`<ws>/work/dsh-ris-ide/lib/proxy.js`、
   `<ws>/../dsh-ris-ide/lib/proxy.js`、`~/.dsh/profiles/web/node_modules/dsh-ris-ide/lib/proxy.js`；
   要求导出 `startProxy` + `mergeConfigs`，否则视为不完整。
2. **内置转发器**（`lib/socks.js`）：`ensureBorrowedProxy` 返回 `mode:'unavailable'` 时由
   `prepareStart` 调 `startForwarder(cfg, targets)`；`isForwarderUp` 幂等。
3. **直连**：`socks=null` 时什么都不起；confcenter 保持原始地址。

`cfg.proxyEngine==='self'` 或 `YDS_IDE_PROXY=none` 可强制第 2 档（用于验证/隔离）。

### 6.2 规则生成与写入

- 规则 **只写真实程序**：`java`（内网 /24 整段）与 `git`（`git.url` 主机），以及外部 IDE 的
  `java`/`git` 路径规则（带 `label`，路径在项目外，靠 `*` 通配版本目录）。
- 端点本身不生成规则行（程序名匹配不到进程）。
- 写全机共享 `~/.dsh-ris-ide/proxy.json`（`DSH_RIS_IDE_PROXY_HOME` 可改），只替换
  `source:'yds'` 的行，其它行原样保留；规则必须同时有「启用+程序+IP+端口」才生效，
  「任意」要显式 `*`。
- 引擎在跑且规则变化 → 重启引擎；否则幂等。

### 6.3 影子监听（shadows）与 git 代理

- 引擎在 `127.0.0.1:<同端口>` 起兜底监听（Oracle/Redis/kafka/ES/license，由端点推导），
  写在配置 `shadows`（引擎输入，界面不显示）；系统层拦截生效后 `shadows` 为空、不绑端口。
- git 代理两侧都写：`git config --global http.https://<克隆URL主机>/.proxy socks5h://<socks>`
  （WSL 侧直接写，Windows 侧用 `git.exe config --global`）。必须 `socks5h`（代理端解析 DNS）。
  只 scope 到克隆 URL 主机；`git.proxy=off` 关闭。

### 6.4 系统层拦截（ProxyBridge）

- `yds start` 顺带启动 ProxyBridge（提权走 UAC/免密 sudo），`yds stop` 顺带停止并清 git；
  三层（引擎、系统层、git）共用一个生命周期。
- 按**进程名**在系统层改路，可覆盖 Navicat、IDE 里的 java、终端 git；
  `127.0.0.1` 映射与启动注入只是它没跑时的后备。
- **默认不拦 java**：WinDivert 路径下 Oracle TNS 首包会被 reset
  （`T2C7Oversion.doOVERSION` → `SQLRecoverableException: Connection reset by peer`），
  YMS 起不来；JVM 自己走 SOCKS 是普通 TCP（WSL 侧一直正常）。需要系统层覆盖其它 java 进程时
  `.env` 写 `proxy.javaRules=on` 再 `yds proxy sync`。git 仍由系统层 + git config 双保险。
- Windows 细节：GUI 服务的 `ProxyBridgeSvc` 与 CLI 互斥（抢 WinDivert），启动 CLI 前先停服务，
  停过的记录在 `proxybridge-service.json`，stop 时恢复；遗留 `ProxyBridge_CLI.exe` 先结束再接管；
  CLI 无日志开关，stdout 重定向 `%TEMP%\dsh-ris-proxybridge.log`，起不来时日志尾部进错误。
  成功标志：日志出现 `java.exe ... -> <redis> via Proxy SOCKS5://...`。
- vendor 随包：`~/.dsh-ris-ide/proxybridge/vendor/{linux,windows}/`；WSL 与 Windows 是两个
  独立进程、各用各的 profile。`yds proxy redirector [status|sync|start|stop]` 是手动入口。
- 体量：引擎约 700 行（ris-ide `lib/proxy.js`），本插件桥接约 260 行（只做规则/配置/git）。

## 7. 两种使用模式（`proxy` / `direct`）与隔离

- `ide.launch=proxy`（默认）：外部 IDE 的 JVM 带 `-DsocksProxyHost/-DsocksProxyPort`，
  读 `yms-home/config`（127.0.0.1 适配）。
- `ide.launch=direct`：JVM **不带任何代理参数**；有 socks 时加
  `-Dlocal_conf_path=<ymsHome>/config-direct/` + `-Dyms_use_local_conf=true`，读原始地址副本。
- 唯一参数来源：`lib/ide.js` 的 `launchModeVmArgs(cfg)`（proxy → `proxyVmArgs`；
  direct+socks → local_conf_path；direct 无 socks → `[]`）。`ourLaunchEntry` 只调它。
- 切换：`applyLaunchConfig` 整体重写条目（proxy→direct 去 socks flags，direct→proxy 去
  `local_conf_path`），无残留；`yds confcenter` 写两份/删过期副本；`yds ide apply` 输出
  `launch 模式: …` 且缺 `config-direct` 时给 ⚠️。
- `yds yoncode patch` 默认跟随模式：direct 时等价 `--no-socks`（默认不再注入 JVM 代理参数），
  避免 F5 时把两种模式混在一起。
- 回归测试：`test/mode-separation.test.mjs`（6 条）钉住「flags / 配置目录 / 切换无残留 / 非法值
  回退」。

## 8. IDE 集成（dsh-ris-ide）

- `yds ide apply`：
  1. 往 `.dsh-ris-ide/config.json` upsert 一条启动器条目（`id: yds:<项目名>`，
     `startCommand: node <插件>/bin/yds.js start --foreground --jvm-args "${JDWP_ARGS}"`）；
     文件不存在时按 ris-ide 自己生成的格式初始化（`version/defaults/programs`）。
  2. 条目名：java 项目取 `parent.artifactId`（bootstrap pom），前端项目取平级
     `module.xml` 的 `module.name`（如 `c-ass-kk-hans-fe`）；老内部名就地改名，避免重复行。
  3. 禁用被启动器取代的后端行，其它行原样保留（ris-ide 的合并/删除语义不受影响）。
  4. 维护 `.vscode/launch.json` 的 `yms-middleware-cloudnative-jdk-21` 条目（与 YonCode
     `ensureLaunchConfig` 同名同构）：`mainClass iuap.yms.YMSLauncher`、`cwd`=`${config:yds.ymsHome}`、
     classPaths 指 `yms.jar`、7 个 `--add-exports` + 16 个 `--add-opens`、`env.YDS_STATE`=
     `${command:yds.preLaunch}`；JSONC 读取（注释/尾逗号/字符串感知状态机），只 upsert 同名条目。
- `lib/ide-watch.js`：注册工作区后监听 `.dsh-ris-ide/config.json`（`fs.watch` + 2s 轮询兜底，
  400ms 去抖）；ris-ide 初始化/点「生成/刷新配置」把它冲掉或改名时自动补回。
  登记在 `~/.dsh-ris-yds/ide-watch.json`（机器级，多工作区）；宿主进程内运行，改代码需重启 dsh。
- 调试链路：`yds ide apply` 写入的 `startCommand` 含 `${JDWP_ARGS}`，之后用
  `ris_dev_debug` / `ris_dev_start` / `ris_dev_stop` 标准启停调试。

## 9. 外部 IDE 兼容补丁（`lib/yoncode.js`）

YonCode 要求 `yds.serverBindAddress` 是本机网卡 IP，否则启动即失败（`Invalid IP address, no
interface found with address …`）；而本插件的回调地址常常是 NAT/端口转发/WSL 外的地址，所以要把
这个校验降级为告警。

- `yds yoncode`（status）：识别 `patched` / `unpatched` / `unrecognised`（不认识的版本不猜）/
  `absent`（正常）；安装目录按 `.env` 的 `yoncode.home` / `YONCODE_HOME` 定位，指定了就只看这一处。
- `yds yoncode patch`：改扩展包两处（同一份 `.bak`）：
  1. `throw` → `console.warn`（网卡校验降级）；
  2. YMS 启动 `vmArgs` 追加 `-DsocksProxyHost/<port>`（为绕开 §6.4 的 TNS reset）。
     幂等；写不动时报「需要管理员或 danger-full-access」，不静默失败。
- `yds yoncode revert`：从 `.bak` 还原。
- `yds ide apply` 时自动检查，未打补丁在输出末尾提示；`yds doctor` 有一行 `yoncode: …`。
  只改 YonCode 自身文件，不碰项目；YonCode 升级重写该文件，重跑一次 patch 即可。

## 10. YYCToken（`lib/token` + `native/`）

`yds token <url>` 用捆绑的 `native/yds-rust.<platform>-<arch>.node`（6 平台）生成 YYCToken；
密钥派生在原生模块里，凭据来自项目 settings，不依赖外部 IDE。原生模块经 `pathToFileURL` 加载
（Windows 盘符/空格路径安全）。

## 11. 前端调试（`lib/fe-dev.js`）

远端页面从平台加载 `/<module>/…/javascripts/extend*.min.js`，本地开发要换成
`http://127.0.0.1:<fe.port>/static/…`。三条路（规则里的模块名/工作台主机/端口全部来自项目配置）：

1. `yds fe rules` → `<workspace>/.dsh-ris-yds/resource-override-rules.json`（7 条，可直接导入
   Resource Override 扩展）；
2. `yds fe plan` → 同样 7 条换成 `{regex, substitution}`，给 agent 用 CDP `Fetch` 注入；
3. `yds fe url <page>` → 追加 `scriptUrl=http://127.0.0.1:<dev端口>/static`（零配置）。

端口来源：`.vscode/settings.json` 的 `yds.webConfig[*].yds.localDevUrl` → 前端工程的
`resource_override_rules.json` → 3004 兜底。

## 12. 浏览器 rdbga 校准（`lib/browser.js`）

网关把请求路由到本机 YMS 的唯一条件：浏览器带着 `rdbga` cookie 且值等于当前 JVM 的 `-Drdbga`。
失败是静默的（页面照常，请求去远端 pod；`logs/access.log` 空、断点不命中）。

- 端口清单唯一来源 `DEVTOOLS_PORTS`（9222/9223/9224/9333）。
- `yds browser status`：逐条标「空值 / 值不匹配 / 正确」，打印期望值及其来源。
- `yds browser fix`：删掉除「唯一且值正确」外的所有 `rdbga`，必要时写入当前值；`--dry-run`
  只打印计划。写入范围受控：只此一个 cookie、只工作台域（`hostname` 精确匹配），值必须是合法的
  `module,/context@ipv4:port` base64，写入后回读确认，否则报失败。
- 期望值优先级：`--rdbga` > 配置推导值；运行中 JVM 的 `-Drdbga` 只用于校验，所有实例都与配置
  不一致时**拒绝写入**（避免指向不存在的实例）。
- `yds start` 成功后自动校准一次（后台/前台/已在运行都尝试；端口没开则静默跳过）。

## 13. 生命周期编排（`lib/cli.js` `prepareStart`）

```
socks 配置 ?
  ├─ 系统层拦截模式 → syncBorrowedRules（只写规则）
  └─ 否则          → ensureBorrowedProxy
                       ├─ mode=ide 且失败 → 直接报错
                       └─ 其它（未装 ris-ide / engine=self）→ isForwarderUp ? 复用 : startForwarder
→ syncRedirectorProfile（有适配器才打印桥接状态；不替你提权）
→ git 代理（git.proxy!=off 且 git.url 存在）applyGitProxy(enabled:true)
→ 启动 YMS（yms.js）→ 成功后 browser 自动校准
```

`yds stop` 顺序相反：停 YMS → 清 git → 停桥接 → 停引擎/内置转发器（`--keep-socks` 保留转发器）
→ `stripLaunchProxy`（摘掉 launch.json 里的 socks 参数）。`rollbackForwarder` 供失败回滚：
`stopBorrowedProxy` + `stopForwarder`，各自 best-effort。
`yds proxy` 子命令在引擎不可用时不提前失败：`sync|start` 回退内置转发器、`status` 显示其状态、
`stop` 一定停转发器、`git-on/off` 不依赖引擎（`test/proxy-standalone.test.mjs` 钉住）。

## 14. 安全与健壮性（实现要点）

- 进程身份校验：pidfile 的 pid 经 `/proc/<pid>/cmdline` 验证（java=YMSLauncher、node=socks-fwd）；
  陈旧 pidfile 清理，pid 复用绝不误杀；非 Linux 平台拒绝陌生 pid。
- 启动失败回滚：120s 就绪超时 → 清 pidfile + TERM + 停转发器；socks 预检快速失败。
- 原子写 + 0600/0700：confcenter 缓存与 config 写入均 tmp+rename；ip_node_mapping 失败先备份。
- JSONC 解析为字符串感知状态机（`http://`、`,]` 等不被误伤），用户条目 round-trip 无损。
- 流式输出不缓冲：mvn 19 分钟输出直转 stdout（`ris_dev_logs` 可跟）；`yds logs` 只读尾部
  ≤256KB；console log 16MB 轮转。
- 跨 OS：native 经 `pathToFileURL`；Windows 上 mvn 走 `mvn.cmd` + shell；JVM 参数引号感知；
  `--flag=true` 解析；spawn 全部 `windowsHide`。
- 脱敏：config/git url 打码 userinfo，描述符 mask `accessSecret`。
- CLI 失败非 0 退出：`run()` 返回 `exitCode`、由 bin 落地（不设 `process.exitCode`），
  agent 工具结果带 `ok:false`；未知命令/动作/多余参数在探测端口前拒绝。

## 15. 已知边界与安全（设计取舍，文档化而非代码限制）

- `workbenchUrl` 是**项目级信任根**：来自被开发仓库的 `.vscode/settings.json`，生成的 maven
  settings 对 jfrog 制品 `checksumPolicy=ignore` ⇒ **不要对不可信仓库执行 `yds build`/`yds start`**
  （理论上可投毒 77MB kernel）。
- SOCKS 转发器本机无鉴权：`127.0.0.1:1521/6890` 上本机任何进程都能穿隧道访问内网；单用户机可接受。
- `yds token` 明文输出 YYCToken（bearer 凭据，进 stdout/日志）——调试用短期凭据，敏感场合自行避免落盘。
- Windows 停机是硬杀（TerminateProcess，Liberty 无优雅停机）；POSIX TERM→30s→KILL。
- `yds browser fix` 会改用户浏览器 cookie（仅工作台域 + 仅 `rdbga`，失败静默）；不确定先 `--dry-run`。
- 直连模式下 `yds start` 不起任何隧道/桥接/git 代理（`test/mode-separation` 覆盖）。

## 16. 测试

```bash
npm test              # node --test "test/*.test.mjs"（100 条）
npm run check:listing # 上架自检 15 项（❌ 必须为 0；⚠️ 需人工确认）
```

覆盖：`cli`（命令/退出码）、`config`（键表/绑定）、`confcenter`、`yms` 启动、`browser`、
`fe-dev`、`ide-config`/`ide-watch`（条目 + 监听）、`launch-proxy`（代理参数注入）、
`mode-separation`（两模式隔离）、`proxy-standalone`（无 ris-ide 回退）、`yoncode`（补丁往返）。

fixture 模式：每个用例 `mkdtemp` 独立工作区 + `stateDir`，写 `.env`/settings.json/confcenter 缓存；
`YDS_IDE_PROXY=none` 模拟未装 ris-ide。真起进程的用例（内置转发器）用空闲端口并 `finally` 清理。

已知：全量并发下个别真 socket 用例偶发超时，单独跑/重跑通过（与 ris-ide 的同类 flake 一致）。

## 17. 发版

- 版本号规则：`X.Y.Z`，X 只给里程碑；Y 用于不兼容/大改；Z 日常。
- 本地：`npm test` → `npm run check:listing` → `npm pack`（约 10MB，含 6 平台 `.node` 与 crx）。
- 仓库内 `Jenkinsfile`：Checkout → Test → Pack → Publish to Nexus（`buildingTag()`，凭据 `nexus`，
  一次性 `.npmrc`）；无 install/build（无依赖、无构建产物）。
- `.github/workflows/publish-npm.yml`：OIDC trusted publishing 发公网 npm（取最新纯 `X.Y.Z` tag，
  与 `npm view` 比较后发布）；`.github/workflows/mirror-from-gitee.yml`：每 2h 从 Gitee 镜像到 GitHub
  并同步 Release。
- 正式链路（与 dsh-ris-ide 相同）：gogs 建「版本发布」+ tag → Jenkins（`PUBLISH` + `PUBLISH_PUBLIC`）
  → Nexus 发布 + 干净快照（单提交）推 Gitee + 同名 tag + Gitee 发行版 → mirror 到 GitHub →
  GitHub Actions 发公网 npm。
  对应 Jenkins job：`master_dsh-ris-yds`（从 `master_dsh-ris-ide` 改：无 Install/Build、
  仓库 `jk.ris.com.cn:30993/haweite/dsh-ris-yds`、Gitee 目标 `riscloud/dsh-ris-yds`、
  提交信息 `dsh-ris-yds <ver>: public release (clean history)`）。
- 首次发布前需人工：公开仓库（Gitee/GitHub + topic `dsh-plugin`）、npm 首次
  `npm publish --access public`、npmjs 配 Trusted Publisher（owner `ris-cloud`、repo `dsh-ris-yds`、
  workflow `publish-npm.yml`）。
- 上架（可选）：awesome-dsh-plugin PR + dsh.so submit；README 需安装命令（已有）与 2–4 张截图。

## 18. 与 dsh-ris-ide 的耦合面

- 只读 + 监听它的 `.dsh-ris-ide/config.json`（§8）；不改它的代码、不需要它知道本插件。
- 借用它的代理引擎时只依赖导出契约：`mergeConfigs / readProxyConfig / writeProxyConfig /
  startProxy / stopProxy / proxyPid / proxyStatus`（`lib/proxy.js`）；不可用则走内置转发器。
- 两个插件可各自单独安装；装在一起时共用同一份代理规则与引擎（不会重复起隧道）。
