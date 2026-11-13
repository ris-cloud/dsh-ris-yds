// dsh-ris-yds plugin entry: tools-only (no browser row). Every agent tool
// funnels into lib/cli.js so the shell CLI, the dsh-ris-ide startCommand and
// the agent tools behave identically.

import { reconcileWorkspaceConfig } from './ide.js'
import { watchAll } from './ide-watch.js'
import { openSite, openSiteStatus, probeWorkspace, closeOpenSites } from './open-serve.js'
import { openDebugForWorkspace } from './dev-open.js'
import {
  devConfigForWorkspace, extensionPageHtml, extensionStatusForWorkspace, writeDevExtensionForWorkspace,
} from './dev-extension.js'

export const name = 'dsh-ris-yds'
export const inject = ['sessions', 'tools', 'webServer']

/** Route prefix this plugin answers on the host's web server. */
const ROUTE_PREFIX = '/dsh-ris-yds'

/** Is this request local (a browser page of this very dsh), not a remote caller? */
function isLoopbackRequest(req) {
  const host = String(req?.headers?.host ?? '')
  if (host === '') return false
  const authority = host.toLowerCase()
  const hostOnly = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.replace(/:\d+$/, '')
  if (!(hostOnly === 'localhost' || hostOnly === '127.0.0.1' || hostOnly === '[::1]' || /^127\./.test(hostOnly))) return false
  const origin = String(req?.headers?.origin ?? '')
  if (origin === '') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function apply(ctx) {
  // 打开前端 dev server：页面经本地注入代理打开（远端 extend 包换成本地、ajax 带 YYCToken）。
  // 只给本机回环请求，且只接受 POST —— 它会让本进程启动一个监听端口。
  if (typeof ctx.webServer?.register === 'function') {
    try {
      const disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const send = (status, body) => {
            const text = JSON.stringify(body)
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(text)
          }
          if (!isLoopbackRequest(req)) {
            send(403, { ok: false, code: 'forbidden', reason: 'this route answers loopback requests only' })
            return
          }
          // Cheap "is this a yds project?" answer for the ris-ide console: it only
          // reads `.vscode/settings.json`, starts nothing, and stays silent for an
          // ordinary workspace so the console never mentions yds there.
          if (url.pathname === `${ROUTE_PREFIX}/probe`) {
            const workspace = String(url.searchParams.get('workspace') ?? '')
            if (workspace === '') {
              send(400, { ok: false, code: 'bad-request', reason: 'workspace is required' })
              return
            }
            try {
              send(200, probeWorkspace(workspace))
            } catch (error) {
              send(500, { ok: false, code: 'error', reason: String(error?.message ?? error) })
            }
            return
          }
          if (url.pathname === `${ROUTE_PREFIX}/status`) {
            const workspace = String(url.searchParams.get('workspace') ?? '')
            if (workspace === '') {
              send(400, { ok: false, code: 'bad-request', reason: 'workspace is required' })
              return
            }
            try {
              send(200, Object.assign({ ok: true }, openSiteStatus(workspace)))
            } catch (error) {
              send(500, { ok: false, code: 'error', reason: String(error?.message ?? error) })
            }
            return
          }
          // The dev extension (assets/dev-extension) bootstraps from its own
          // config.json and then lives off this route: rdbga, module, workbench host and
          // the front-end port all come from the project, so a yds upgrade needs no
          // re-import as long as the extension's own files did not change.
          if (url.pathname === `${ROUTE_PREFIX}/dev-config`) {
            const workspace = String(url.searchParams.get('workspace') ?? '')
            if (workspace === '') {
              send(400, { ok: false, code: 'bad-request', reason: 'workspace is required' })
              return
            }
            try {
              send(200, devConfigForWorkspace(workspace))
            } catch (error) {
              send(500, { ok: false, code: 'error', reason: String(error?.message ?? error) })
            }
            return
          }
          // Browser-extension maintenance for the ris-ide console tab: status (GET),
          // materialize the loadable folder (POST), and the self-contained page.
          if (url.pathname === `${ROUTE_PREFIX}/extension-page`) {
            const workspace = String(url.searchParams.get('workspace') ?? '')
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(extensionPageHtml(workspace))
            return
          }
          if (url.pathname === `${ROUTE_PREFIX}/extension`) {
            const workspace = String(url.searchParams.get('workspace') ?? '')
            if (req.method === 'GET') {
              if (workspace === '') {
                send(400, { ok: false, code: 'bad-request', reason: 'workspace is required' })
                return
              }
              try {
                send(200, extensionStatusForWorkspace(workspace))
              } catch (error) {
                send(500, { ok: false, code: 'error', reason: String(error?.message ?? error) })
              }
              return
            }
            if (req.method !== 'POST') {
              send(405, { ok: false, code: 'method-not-allowed', reason: 'GET or POST' })
              return
            }
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
              let body = {}
              try {
                body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch {
                send(400, { ok: false, code: 'bad-request', reason: 'body is not JSON' })
                return
              }
              const target = String(body?.workspace ?? workspace)
              if (target === '') {
                send(400, { ok: false, code: 'bad-request', reason: 'workspace is required' })
                return
              }
              const options = {}
              if (typeof body?.dir === 'string' && body.dir.trim() !== '') options.dir = body.dir.trim()
              if (Number(body?.dshPort) > 0) options.dshPort = Number(body.dshPort)
              try {
                const result = writeDevExtensionForWorkspace(target, options)
                if (result.ok === true) {
                  send(200, { ...result, ...extensionStatusForWorkspace(target, options) })
                } else {
                  send(400, result)
                }
              } catch (error) {
                send(500, { ok: false, code: 'error', reason: String(error?.message ?? error) })
              }
            })
            return
          }
          if (url.pathname !== `${ROUTE_PREFIX}/open`) {
            send(404, { ok: false, code: 'not-found', reason: url.pathname })
            return
          }
          if (req.method !== 'POST') {
            send(405, { ok: false, code: 'method-not-allowed', reason: 'POST only' })
            return
          }
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            let body = {}
            try {
              body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              send(400, { ok: false, code: 'bad-request', reason: 'body is not JSON' })
              return
            }
            const workspace = String(body?.workspace ?? '')
            if (workspace === '') {
              send(400, { ok: false, code: 'bad-request', reason: 'workspace is required' })
              return
            }
            // Two ways to open a frontend, both driven by the same ris-ide 🌐 button:
            //  - proxy (default): loopback proxy that rewrites extend bundles;
            //  - debug: start the private profile browser (extension preloaded, CDP on).
            // Debug mode is what makes the page's own requests carry rdbga, so the
            // gateway routes them to this machine instead of the remote pod.
            if (body?.mode === 'debug') {
              openDebugForWorkspace(workspace, {
                url: typeof body?.url === 'string' ? body.url : undefined,
                port: Number(body?.port) > 0 ? Number(body.port) : undefined,
              })
                .then((result) => send(200, result))
                .catch((error) => send(500, { ok: false, code: 'error', reason: String(error?.message ?? error) }))
              return
            }
            // `frontend` names the yds front-end project the caller wants injected
            // (m00555): the workspace may declare several, each on its own port, and
            // injecting another one's rules opens the wrong page. A refusal answers
            // 200 with `ok:false` so the caller can simply open the page directly.
            const frontend = body?.frontend !== null && typeof body?.frontend === 'object' && typeof body.frontend.code === 'string'
              ? { code: body.frontend.code }
              : undefined
            openSite(workspace, {
              devUrl: typeof body?.devUrl === 'string' ? body.devUrl : undefined,
              frontend,
            })
              .then((result) => send(200, result))
              .catch((error) => send(500, { ok: false, code: 'error', reason: String(error?.message ?? error) }))
          })
        },
      })
      ctx.effect?.(() => () => {
        try { disposeRoute?.() } catch { /* ignore */ }
        closeOpenSites()
      }, 'dsh-ris-yds: open-site route')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ris-yds: open route not registered: ${String(error)}`)
    }
  }
  // Keep the launcher row in ris-ide's config after it regenerates the file.
  // We only observe (see lib/ide-watch.js): ris-ide is never modified.
  let stopWatching = () => {}
  try {
    stopWatching = watchAll(
      { repair: (workspace) => reconcileWorkspaceConfig(workspace) },
      { log: ctx.logger?.info?.bind(ctx.logger) ?? (() => {}) },
    )
  } catch (error) {
    ctx.logger?.warn?.(`dsh-ris-yds: config watcher not started: ${String(error)}`)
  }
  if (typeof ctx.tools?.register !== 'function') {
    ctx.logger?.warn?.('dsh-ris-yds: ctx.tools missing; tools stay unregistered')
    return
  }
  const disposers = []
  const register = (definition) => {
    try {
      disposers.push(ctx.tools.register(definition))
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ris-yds: tool ${definition.name} not registered: ${String(error)}`)
    }
  }
  const scopeOf = (exec) => {
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('this tool needs a live agent session')
    }
    const session = ctx.sessions?.get?.(sessionId)
    const headerCwd = session?.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
    if (typeof exec?.cwd === 'string' && exec.cwd !== '') return exec.cwd
    throw new Error(`no working directory for session "${sessionId}"`)
  }
  const text = (value) => [{ type: 'text', text: value }]

  const LOOSE_OUTPUT = {
    type: 'object',
    additionalProperties: true,
    properties: { ok: { type: 'boolean' } },
  }

  const runCli = async (exec, argv) => {
    const { run } = await import('./cli.js')
    const cwd = scopeOf(exec)
    exec?.signal?.throwIfAborted?.()
    const result = await run(argv, { cwd })
    if (result === undefined) return result
    // Tools never touch process.exitCode (that would leak into the dsh host); they
    // report the outcome in the payload instead.
    const { exitCode = 0, ...rest } = result
    return { ...rest, ok: exitCode === 0 }
  }

  register({
    name: 'yds_doctor',
    description: 'YDS 环境体检：解析项目 settings.json 与可选 .env 的生效配置（SOCKS/直连、回调地址、端口、JDK），'
      + '检查 yms-home 构建状态、YMS 进程/端口/ready、socks 转发器，并列出缺失项。'
      + '新环境装上插件后从这里开始；配置缺失会给出精确的补齐指引。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['doctor']),
  })

  register({
    name: 'yds_config',
    description: '显示 YDS 生效配置（键值+来源：项目 settings.json / workspace .env / 环境变量），凭据打码。'
      + '含 module、workbenchUrl、serverBindAddress/serverPort（回调）、ymsPort（本地监听）、socks、git、maven。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['config']),
  })

  register({
    name: 'yds_token',
    description: '生成调用本地 YMS 或远端平台 API 的 YYCToken（请求头 YYCToken）。token 与 URL 绑定宽松（根 URL token 可打任意路径）。'
      + '凭据自动取自项目 settings.json 的 yds.accessKey/accessSecret。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', description: '要授权的完整 URL（如 https://<workbench>/c-ass-kk-hans/_yms/ready）' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['token', args.url]),
  })

  register({
    name: 'yds_confcenter',
    description: '拉取（或离线使用缓存）confcenter 的 4 个 YMS 配置文件并适配写入 yms-home/config：'
      + 'SOCKS 模式把 DB/Redis 地址改写为本地转发端口，直连模式保持原地址；ip_node_mapping 指向回调地址。'
      + '--offline 用 .dsh-ris-yds/confcenter 缓存（网络不可达时启动用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { offline: { type: 'boolean', description: '不联网，用上次拉取的缓存' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['confcenter', ...(args?.offline === true ? ['--offline'] : [])]),
  })

  register({
    name: 'yds_build',
    description: '从零构建 yms-home（首次含 77MB kernel 从 jfrog 下载，约 19 分钟；缓存后约 1 分钟）：'
      + 'maven yms-module 部署 + confcenter 拉取适配 + JDK 指针。不依赖本机既有产物，新环境可直接跑。'
      + '需要 JDK 与 mvn 在 PATH（或 .env 的 java.path / maven.* 指定）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['build']),
  })

  register({
    name: 'yds_start',
    description: '后台启动本地 YMS（幂等）：socks 已配置则自动起本地转发器，yms-home/config 缺失则自动补（缓存或在线拉取），'
      + '然后以脱离进程启动 Liberty，等端口就绪。返回 pid、端口、rdbga cookie 值（种到 workbench 域即可让网关路由回调本机）。'
      + '已运行时返回 alreadyRunning（pidfile 丢失但进程仍在时会按端口接管并补登记）。restart=true 先停止现有实例再启动。'
      + '需要 JDWP 调试请走 yds_ide + ris_dev_debug。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jvmArgs: { type: 'string', description: '额外 JVM 参数（空格分隔）' },
        restart: { type: 'boolean', description: '重启：先停止正在运行的 YMS（含 pidfile 丢失、按端口识别到的实例）再启动' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, [
      'start',
      ...(args?.restart === true ? ['--restart'] : []),
      ...(typeof args?.jvmArgs === 'string' && args.jvmArgs !== '' ? ['--jvm-args', args.jvmArgs] : []),
    ]),
  })

  register({
    name: 'yds_stop',
    description: '停止本地 YMS（TERM→宽限→KILL，pidfile 验证）。默认同时停 socks 转发器；keepSocks=true 保留（例如共享给其它任务）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { keepSocks: { type: 'boolean', description: '保留 socks 转发器' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['stop', ...(args?.keepSocks === true ? ['--keep-socks'] : [])]),
  })

  register({
    name: 'yds_status',
    description: 'YMS 运行状态：进程 pid、端口监听、/_yms/ready HTTP 状态、yms-home 构建与 config 就绪、socks 转发器。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['status']),
  })

  register({
    name: 'yds_logs',
    description: 'tail 本地 YMS 日志（Liberty 控制台 + 应用 yms-application.log），默认 80 行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { lines: { type: 'number', description: '行数（默认 80）' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['logs', '--lines', String(args?.lines ?? 80)]),
  })

  register({
    name: 'yds_ide',
    description: '维护 dsh-ris-ide 的项目运行配置 .dsh-ris-ide/config.json：把本地 YMS 作为一个程序条目（startCommand 含 ${JDWP_ARGS} 占位符）'
      + 'upsert 进去，之后可用 ris_dev_start/ris_dev_stop 启停、ris_dev_debug 断点调试（JDWP）。'
      + '同时维护项目根 .vscode/launch.json 的 yms-middleware-cloudnative-jdk-21 条目（与 YonCode 生成物同名同构，YonCode 端 F5 可直接启动/调试 YMS）。'
      + '只增改自己的一条（按名字匹配），其余用户/面板/YonCode 条目原样保留。action=check（默认）/apply/remove。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string', description: 'check（默认）| apply | remove' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['ide', args?.action ?? 'check']),
  })

  register({
    name: 'yds_proxy',
    description: '代理引擎（借用 dsh-ris-ide 的 proxy.js，与 IDE 控制台的 🌐 弹窗共享同一份规则与同一个进程）：'
      + 'status 看引擎与 yds 规则；sync/start 按 confcenter 缓存的 DB/Redis/内网端点自动生成 source=yds 的规则并启动引擎'
      + '（literal IPv4 目标会在本机 127.0.0.1:同端口 上做映射，供 JDBC/Redis 这类不支持 SOCKS 的客户端使用）；'
      + 'stop 停引擎；git-on/git-off 写入/清除 scope 到配置 URL 主机的 git 代理（普通 git 与 dsh-git 都会生效，无需 -c 参数）。'
      + '未安装 dsh-ris-ide 时 yds start 自动回退内置转发器。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string', description: 'status（默认）| sync | start | stop | git-on | git-off' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['proxy', args?.action ?? 'status']),
  })

  register({
    name: 'yds_browser',
    description: '工作台浏览器（YonCode 内置 Chrome / yds 启动的调试浏览器 / 任意开了 DevTools 端口的浏览器）的 rdbga cookie 体检与校准，'
      + '以及**由 yds 自己启动一个带扩展的调试浏览器**：'
      + 'debug 用独立 profile 启动 Chrome/Edge（--load-extension 预装 ris-yds-extension、--remote-debugging-port 开 DevTools），'
      + '不需要手工装扩展，也不影响日常浏览器；stop 只停 yds 启动的那个实例（pidfile + 进程身份校验，不误杀）。'
      + 'status 列出 DevTools 端口/工作台页签/期望值（含来源）/调试浏览器状态；fix 删除空值/重复/不匹配的 rdbga 并写入当前值'
      + '（网关只在该 cookie 等于当前 JVM 的 -Drdbga 时把请求路由到本机；空 host-only rdbga 会让请求全去远端 pod，页面正常但本机无日志）。'
      + 'fix 默认只预览（dry_run=true），确认后才用 dry_run=false 真正写入；只动 rdbga、只动工作台域。'
      + 'yds start 成功后会自动校准一次（后台/前台/已在运行都会，浏览器没开则跳过）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'status（默认）| fix | debug | stop' },
        dry_run: { type: 'boolean', description: 'fix 默认 true=只预览；真正写入浏览器 cookie 需显式 false' },
        url: { type: 'string', description: 'debug 时打开的页面（默认项目 workbenchUrl）' },
        port: { type: 'number', description: 'debug 时的 DevTools 端口（默认 9222）' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => {
      const action = args?.action ?? 'status'
      const argv = ['browser', action]
      if (action === 'fix' && args?.dry_run !== false) argv.push('--dry-run')
      if ((action === 'debug' || action === 'status') && typeof args?.url === 'string' && args.url !== '') argv.push('--url', args.url)
      if (Number(args?.port) > 0) argv.push('--port', String(args.port))
      return runCli(exec, argv)
    },
  })

  register({
    name: 'yds_yoncode',
    description: 'YonCode 的 serverBindAddress 网卡校验（YonCode 要求启动地址是本机网卡 IP；本插件用回调地址/端口转发时会拒绝启动）：'
      + 'status 检测安装位置与状态（patched/unpatched/absent，可用 .env 的 yoncode.home 指定安装目录）；'
      + 'patch 把该校验改成告警（写 YonCode 安装目录，先备份 .bak；写不动会提示需要管理员/danger-full-access 提权）；'
      + 'revert 从 .bak 还原。只改 YonCode 自己的文件，不动项目。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string', description: 'status（默认）| patch | revert' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['yoncode', args?.action ?? 'status']),
  })

  register({
    name: 'yds_fe',
    description: '前端本地联调接入（值全部取自当前 yds 项目，不硬编码）：'
      + 'extension 生成/更新「ris-yds-extension」浏览器扩展目录（扩展负责给 /<module>/** 请求加 rdbga 头、把远端 extend*.min.js|css 换成 127.0.0.1:<dev端口>/static，'
      + '值由扩展向本机 /dsh-ris-yds/dev-config 动态拉取，插件升级后一般无需重装）；'
      + 'plan 打印「正则 + 替换」清单，agent 可用 CDP Fetch 自行注入（不装扩展）；'
      + 'url <page> 给页面 URL 追加 scriptUrl 参数（前端自己支持的零配置路径）。'
      + '注意：浏览器不允许网页直接安装扩展，extension 只生成目录，用户需在 chrome://extensions「加载已解压的扩展程序」选一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'extension（默认）| plan | url' },
        page: { type: 'string', description: 'action=url 时的页面 URL（绝对或站内路径）' },
        dir: { type: 'string', description: 'action=extension 时自定义扩展目录（默认 <workspace>/.dsh-ris-yds/dev-extension）' },
        force: { type: 'boolean', description: 'action=extension 时已存在也重新生成（插件升级后用）' },
        dshPort: { type: 'number', description: 'action=extension 时扩展回连的 DSH 端口（默认 3080）' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => {
      const argv = ['fe', args?.action ?? 'extension']
      if (typeof args?.page === 'string' && args.page !== '') argv.push(args.page)
      if (typeof args?.dir === 'string' && args.dir !== '') argv.push('--dir', args.dir)
      if (Number(args?.dshPort) > 0) argv.push('--dsh-port', String(args.dshPort))
      if (args?.force === true) argv.push('--force')
      return runCli(exec, argv)
    },
  })

  return () => {
    try { stopWatching() } catch { /* ignore */ }
    try { closeOpenSites() } catch { /* ignore */ }
    disposers.forEach((dispose) => { try { dispose() } catch { /* ignore */ } })
  }
}
