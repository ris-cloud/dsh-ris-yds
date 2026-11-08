// dsh-ris-yds plugin entry: tools-only (no browser row). Every agent tool
// funnels into lib/cli.js so the shell CLI, the dsh-ris-ide startCommand and
// the agent tools behave identically.

import { reconcileWorkspaceConfig } from './ide.js'
import { watchAll } from './ide-watch.js'

export const name = 'dsh-ris-yds'
export const inject = ['sessions', 'tools']

export function apply(ctx) {
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
      + '已运行时返回 alreadyRunning。需要 JDWP 调试请走 yds_ide + ris_dev_debug。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { jvmArgs: { type: 'string', description: '额外 JVM 参数（空格分隔）' } },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => runCli(exec, ['start', ...(typeof args?.jvmArgs === 'string' && args.jvmArgs !== '' ? ['--jvm-args', args.jvmArgs] : [])]),
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
    description: '工作台浏览器（YonCode 内置 Chrome / 任意开了 DevTools 端口的浏览器）的 rdbga cookie 体检与校准：'
      + '网关只在该 cookie 等于当前 JVM 的 -Drdbga 时把请求路由到本机；一个空的 host-only rdbga 会覆盖正确值，'
      + '导致页面看着正常但请求全去远端 pod（本机日志空、断点不进）。'
      + 'status 列出 DevTools 端口/工作台页签/期望值（含来源）；fix 删除空值/重复/不匹配的 rdbga 并写入当前值。'
      + 'fix 默认只预览（dry_run=true），确认后才用 dry_run=false 真正写入；只动 rdbga、只动工作台域。'
      + 'yds start 成功后会自动校准一次（后台/前台/已在运行都会，浏览器没开则跳过）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'status（默认）| fix' },
        dry_run: { type: 'boolean', description: 'fix 默认 true=只预览；真正写入浏览器 cookie 需显式 false' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => {
      const action = args?.action ?? 'status'
      const argv = ['browser', action]
      if (action === 'fix' && args?.dry_run !== false) argv.push('--dry-run')
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
    description: '前端调试（webpack dev server）的两种接入方式，值全部取自当前项目配置（module/domainKey、workbench 主机、yds.webConfig 里的 dev 端口）：'
      + 'rules 生成 Resource Override Chrome 插件的规则文件（写到 <workspace>/.dsh-ris-yds/resource-override-rules.json，'
      + '在插件里导入即可把远端 extend*.min.js/css 换成 127.0.0.1:<dev端口>/static 本地文件）；'
      + 'plan 打印同样的规则转换成的「正则 + 替换」清单，agent 可以用 CDP Fetch 拦截自行注入（不需要装扩展）；'
      + 'url <page> 给页面 URL 追加 scriptUrl 参数（零配置路径，前端自己支持）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'rules（默认）| plan | url' },
        page: { type: 'string', description: 'action=url 时的页面 URL（绝对或站内路径）' },
      },
    },
    output: { schema: LOOSE_OUTPUT, render: (_a, value) => text(value?.text ?? '') },
    execute: async (args, exec) => {
      const argv = ['fe', args?.action ?? 'rules']
      if (typeof args?.page === 'string' && args.page !== '') argv.push(args.page)
      return runCli(exec, argv)
    },
  })

  return () => {
    try { stopWatching() } catch { /* ignore */ }
    disposers.forEach((dispose) => { try { dispose() } catch { /* ignore */ } })
  }
}
