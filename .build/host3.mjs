// Host patch 3 (1.2.2): stamp every event with a per-boot id so the frontend can tell
// "a new Host process restarted the sequence" from "a duplicate I already handled".
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'index.js')

let s = fs.readFileSync(TARGET, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')

function rep(name, from, to, expect = 1) {
  const n = s.split(from).length - 1
  if (n !== expect) {
    console.error('MISMATCH [' + name + '] found=' + n + ' expected=' + expect)
    process.exit(1)
  }
  s = s.split(from).join(to)
  console.log('ok  ' + name)
}

rep('B1 version', `const PLUGIN_VERSION = '1.2.1'`, `const PLUGIN_VERSION = '1.2.2'`)

rep(
  'B2 runtime bootId',
  `    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底
    eventSeq: 0,
    inbox: [],`,
  `    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底。
    // bootId = 本次 Host 进程的启动标识：seq 只在同一个 bootId 内可比，
    // 进程重启后 seq 会从头开始，前端必须能分辨这件事（否则会把新事件当旧的丢掉）。
    eventSeq: 0,
    bootId: '',
    inbox: [],`,
)

rep(
  'B3 publishEvent boot',
  `  const publishEvent = (payload, keepInInbox = true) => {
    runtime.eventSeq += 1
    const item = Object.assign({ seq: runtime.eventSeq, at: Date.now() }, payload)`,
  `  const publishEvent = (payload, keepInInbox = true) => {
    runtime.eventSeq += 1
    const item = Object.assign({ seq: runtime.eventSeq, boot: runtime.bootId, at: Date.now() }, payload)`,
)

rep(
  'B4 inbox route boot',
  `        const items = since === null ? [] : runtime.inbox.filter((x) => x.seq > since)
        sendJson(res, 200, { ok: true, seq: runtime.eventSeq, items, serverTime: now })`,
  `        const items = since === null ? [] : runtime.inbox.filter((x) => x.seq > since)
        sendJson(res, 200, { ok: true, boot: runtime.bootId, seq: runtime.eventSeq, items, serverTime: now })`,
)

rep(
  'B5 init payload boot',
  `          session: sessionView(),
          native: probeNative(),
          localNow: localParts(Date.now()).hhmm,`,
  `          session: sessionView(),
          native: probeNative(),
          boot: runtime.bootId,
          localNow: localParts(Date.now()).hhmm,`,
)

rep(
  'B6 status payload boot',
  `          alarms: alarmSchedule(),
          native: runtime.native,
          localNow: localParts(Date.now()).hhmm,`,
  `          alarms: alarmSchedule(),
          native: runtime.native,
          boot: runtime.bootId,
          localNow: localParts(Date.now()).hhmm,`,
)

rep(
  'B7 diag events boot',
  `          events: {
            sseClients: runtime.sseClients.size,`,
  `          events: {
            boot: runtime.bootId,
            sseClients: runtime.sseClients.size,`,
)

rep(
  'B8 set bootId on start',
  `  const start = () => {
    stateDir = pickStateDir()`,
  `  const start = () => {
    // 每次 Host 启动一个新的 bootId：前端靠它区分「序号从头开始」和「重复事件」
    runtime.bootId = 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    stateDir = pickStateDir()`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
