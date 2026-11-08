// SOCKS forwarder: local TCP listeners that tunnel through a SOCKS5 proxy to
// the real DB/Redis. Only started when .env carries socks.host;
// without it everything connects directly (requirement 2).
//
// The forwarder runs as its own detached process (`yds socks-fwd`) with a
// pidfile in .dsh-ris-yds/; start/stop are idempotent.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

export function socksPidFile(cfg) {
  return join(cfg.stateDir, 'socks-forward.pid')
}

/**
 * Verify a pid is really our process (guards against pid reuse after a
 * crash/reboot: a bare pid from a stale pidfile could be an unrelated
 * process — never signal it). Identity = /proc/<pid>/cmdline contains our
 * marker. Returns false when /proc is unavailable (non-Linux): the caller
 * then treats the pid as unverified and refuses to kill it.
 */
export function pidIsOurs(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmd.includes(marker)
  } catch { return false }
}

/** Read + verify the forwarder pidfile; null when absent/stale/foreign. */
export function forwarderPid(cfg) {
  const pidFile = socksPidFile(cfg)
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0 || !pidIsOurs(pid, 'socks-fwd')) {
    try { if (Number.isInteger(pid) && pid > 0 && !pidIsOurs(pid, 'socks-fwd') && !pidIsAlive(pid)) unlinkSync(pidFile) } catch { /* ignore */ }
    return null
  }
  return pid
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function portOpen(host, port, timeout = 1500) {
  return new Promise((resolve_) => {
    const sock = net.connect({ host, port })
    const done = (ok) => { sock.destroy(); resolve_(ok) }
    sock.setTimeout(timeout, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * Our forwarder is "up" only when the pidfile pid is alive AND is ours AND
 * the port answers. A port answering without our pid = some other local
 * service (e.g. a local Oracle on 1521) — NOT the tunnel.
 */
export function isForwarderUp(cfg) {
  return (async () => {
    const pid = forwarderPid(cfg)
    if (pid === null) return false
    return (await portOpen('127.0.0.1', cfg.dbForwardPort, 400)) || (await portOpen('127.0.0.1', cfg.redisForwardPort, 400))
  })()
}

/**
 * Spawn the detached forwarder process (idempotent). `targets` come from the
 * confcenter adaptation: [{ host, port, localPort?, isRedis? }] — an explicit
 * localPort (yonbip extras: kafka/ES/license keep their own port number)
 * wins, db gets dbForwardPort, redis gets redisForwardPort.
 */
export async function startForwarder(cfg, targets, { logPath } = {}) {
  if (cfg.socks === null) return { started: false, reason: 'socks 未配置（直连模式，无需转发）' }
  if (await isForwarderUp(cfg)) {
    return { started: false, reason: '转发器已在监听' }
  }
  await stopForwarder(cfg)
  mkdirSync(cfg.stateDir, { recursive: true })
  const specs = []
  for (const t of targets) {
    const localPort = Number.isInteger(t.localPort) ? t.localPort
      : (t.isRedis === true ? cfg.redisForwardPort : cfg.dbForwardPort)
    if (specs.some((s) => s.local === localPort)) continue
    specs.push({ local: localPort, host: t.host, port: t.port })
  }
  if (specs.length === 0) specs.push({ local: cfg.dbForwardPort, host: '', port: 0 }) // never used
  const args = specs.map((s) => `${s.local}:${s.host}:${s.port}`)
  const bin = fileURLToPath(new URL('../bin/yds.js', import.meta.url))
  const out = logPath ?? join(cfg.stateDir, 'socks-forward.log')
  const { openSync } = await import('node:fs')
  const outFd = openSync(out, 'a')
  const child = spawn(process.execPath, [bin, 'socks-fwd', `--socks=${cfg.socks.host}:${cfg.socks.port}`, ...args], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: process.env,
  })
  child.unref()
  writeFileSync(socksPidFile(cfg), String(child.pid), 'utf8')
  const portsUp = async () => {
    // every spec must listen; report the first one that does not
    for (const s of specs) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await portOpen('127.0.0.1', s.local, 150))) return s.local
    }
    return null
  }
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const down = await portsUp()
    if (down === null) break
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200))
  }
  // the wait loop above can exhaust without the port ever answering (child
  // crashed instantly, e.g. EADDRINUSE) — verify before reporting success.
  const down = await portsUp()
  const alive = pidIsAlive(child.pid)
  if (down !== null || !alive) {
    try { unlinkSync(socksPidFile(cfg)) } catch { /* ignore */ }
    throw new Error(`socks 转发器启动失败（端口 ${down ?? '?'} 未监听 / 进程存活=${alive}）——详情见 ${out}（端口被占或其他本地服务在 127.0.0.1:${down}？）`)
  }
  return { started: true, pid: child.pid, targets: args, log: out }
}

/** Stop the detached forwarder if its pidfile pid is ours (never kill a reused foreign pid). */
export async function stopForwarder(cfg) {
  const pid = forwarderPid(cfg)
  if (pid === null) return { stopped: false, reason: 'pidfile 不存在或非本工具进程' }
  const pidFile = socksPidFile(cfg)
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  for (let i = 0; i < 25; i += 1) {
    try {
      process.kill(pid, 0)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200))
    } catch { break }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  try { unlinkSync(pidFile) } catch { /* ignore */ }
  return { stopped: true, pid }
}

/** SOCKS5 no-auth handshake + CONNECT, promise-based (proven implementation). */
const SOCKS_CONNECT_TIMEOUT_MS = 15000

function connectSocks(targetHost, targetPort, socksHost, socksPort) {
  return new Promise((resolve_, reject_) => {
    const sock = net.connect(socksPort, socksHost)
    const timer = setTimeout(() => { try { sock.destroy() } catch { /* ignore */ } reject_(new Error('socks connect timeout')) }, SOCKS_CONNECT_TIMEOUT_MS)
    const settle = (fn) => (arg) => { clearTimeout(timer); fn(arg) }
    sock.once('error', settle(reject_))
    sock.once('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])) // greeting: no-auth
      sock.once('data', (buf) => {
        if (buf.length < 2 || buf[0] !== 0x05) { sock.destroy(); return reject_(new Error('bad socks greeting')) }
        if (buf[1] !== 0x00) { sock.destroy(); return reject_(new Error('socks requires auth')) }
        const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(targetHost)
        let req
        if (isIp) {
          req = Buffer.alloc(10)
          req[0] = 0x05; req[1] = 0x01; req[3] = 0x01
          targetHost.split('.').forEach((o, i) => { req[4 + i] = Number(o) })
          req.writeUInt16BE(targetPort, 8)
        } else {
          const name = Buffer.from(targetHost, 'utf8')
          req = Buffer.alloc(7 + name.length)
          req[0] = 0x05; req[1] = 0x01; req[3] = 0x03; req[4] = name.length
          name.copy(req, 5)
          req.writeUInt16BE(targetPort, 5 + name.length)
        }
        sock.write(req)
        let acc = Buffer.alloc(0)
        const onReply = (buf) => {
          acc = Buffer.concat([acc, buf])
          if (acc.length < 4) return
          const atyp = acc[3]
          const need = atyp === 0x01 ? 10 : (atyp === 0x03 ? 5 + acc[4] + 2 : (atyp === 0x04 ? 22 : -1))
          if (need < 0 || acc.length < need) return
          sock.removeListener('data', onReply)
          if (acc[1] !== 0x00) { sock.destroy(); return reject_(new Error(`socks CONNECT failed rep=${acc[1]}`)) }
          if (acc.length > need) sock.unshift(acc.subarray(need))
          clearTimeout(timer)
          resolve_(sock)
        }
        sock.on('data', onReply)
      })
    })
  })
}

/** The forwarder loop (runs inside `yds socks-fwd`). */
/**
 * Health probe: full SOCKS5 handshake + CONNECT to one target. Returns true
 * when the tunnel actually forwards (rep=0). Distinguishes "forwarder
 * listening" from "remote machine can still reach the resource" — the
 * one-way tunnel on the remote dev machine can go down independently.
 */
export function probeSocksConnect(socks, target, timeout = 8000) {
  return new Promise((resolve_) => {
    let phase = 0
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve_(v) } }
    let socket
    try { socket = net.connect(socks.port, socks.host) } catch { resolve_(false); return }
    socket.setTimeout(timeout, () => { done(false); socket.destroy() })
    socket.on('error', () => done(false))
    socket.on('connect', () => {
      try { socket.write(Buffer.from([5, 1, 0])) } catch { done(false) }
    })
    socket.on('data', (d) => {
      if (settled) return
      if (phase === 0) {
        if (d.length < 2 || d[0] !== 5 || d[1] !== 0) { done(false); socket.destroy(); return }
        phase = 1
        const host = Buffer.from(target.host, 'utf8')
        const port = target.port
        const req = Buffer.from([5, 1, 0, 3, host.length, ...host, Math.floor(port / 256), port % 256])
        try { socket.write(req) } catch { done(false) }
      } else {
        done(d.length >= 2 && d[1] === 0)
        socket.destroy()
      }
    })
  })
}

export function runForwarder(socksHost, socksPort, specs) {
  console.log(`[yds] socks=${socksHost}:${socksPort}`)
  let failures = 0
  for (const s of specs) {
    const server = net.createServer((client) => {
      connectSocks(s.host, s.port, socksHost, socksPort).then((remote) => {
        client.pipe(remote)
        remote.pipe(client)
        const done = () => { try { client.destroy(); remote.destroy() } catch { /* ignore */ } }
        client.on('error', done); remote.on('error', done)
        client.on('close', done); remote.on('close', done)
      }).catch((e) => {
        console.error(`[yds] ${s.local}->${s.host}:${s.port} failed: ${e.message}`)
        client.destroy()
      })
    })
    // without this listener EADDRINUSE (or any bind failure) becomes an
    // uncaught exception in the detached child — parent then reports success.
    server.on('error', (e) => {
      failures += 1
      console.error(`[yds] listen 127.0.0.1:${s.local} failed: ${e.message}`)
      if (failures >= specs.length) process.exit(1)
    })
    server.listen(s.local, '127.0.0.1', () => {
      console.log(`[yds] forward 127.0.0.1:${s.local} -> ${s.host}:${s.port}`)
    })
  }
}
