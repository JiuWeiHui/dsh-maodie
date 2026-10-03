// Host patch 4 (1.2.4):
//   - normalize alarm time matching ("8:15" / "08:15" / "08:15:00" all work)
//   - the CURRENT minute counts as "due" in the schedule (it used to be skipped,
//     so setting a time to the current minute displayed "tomorrow" and looked like
//     the alarm had been skipped past)
//   - /maodie/diag exposes the last alarm check, so "why didn't it ring" is one glance
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

rep('E1 version', `const PLUGIN_VERSION = '1.2.3'`, `const PLUGIN_VERSION = '1.2.4'`)

// ---------------------------------------------------------------- E2 normalized time key
rep(
  'E2 alarmTimeKey',
  `  // 闹钟排程（本地时间）：到点没响时能一眼看出排程对不对
  const alarmSchedule = () => {`,
  `  // 闹钟时间统一成 "HH:MM"：不管存进来的是 "8:15"、"08:15" 还是 "08:15:00"，
  // 都能对上 —— 之前用字符串全等比较，一个格式差异就会让它**永远不响**。
  const alarmTimeKey = (value) => {
    const m = /^\\s*(\\d{1,2}):(\\d{2})/.exec(String(value === undefined || value === null ? '' : value))
    if (!m) return ''
    return String(Number(m[1])).padStart(2, '0') + ':' + m[2]
  }

  // 闹钟排程（本地时间）：到点没响时能一眼看出排程对不对
  const alarmSchedule = () => {`,
)

// ---------------------------------------------------------------- E3 checkAlarms uses it
rep(
  'E3 checkAlarms matching',
  `    for (const alarm of alarms) {
      if (!alarm || alarm.enabled === false) continue
      const time = String(alarm.time || '')
      if (time !== hhmm) continue`,
  `    for (const alarm of alarms) {
      if (!alarm || alarm.enabled === false) continue
      const time = alarmTimeKey(alarm.time)
      if (time === '' || time !== hhmm) continue`,
)

// ---------------------------------------------------------------- E4 schedule: current minute is due
rep(
  'E4 alarmSchedule',
  `      const m = /^(\\d{1,2}):(\\d{2})$/.exec(String(a.time || ''))
      const entry = {`,
  `      const key = alarmTimeKey(a.time)
      const m = key === '' ? null : [key, key.slice(0, 2), key.slice(3)]
      const entry = {`,
)
rep(
  'E4b schedule next computation',
  `      if (m && entry.enabled) {
        const hh = Number(m[1])
        const mm = Number(m[2])
        for (let d = 0; d <= 8; d++) {
          const t = new Date(now + d * 86400000)
          t.setHours(hh, mm, 0, 0)
          const ms = t.getTime()
          if (ms <= now) continue`,
  `      if (m && entry.enabled) {
        const hh = Number(m[1])
        const mm = Number(m[2])
        // 「就在这一分钟」也算还没到：否则刚设好、秒数已经走了一点，
        // 就会显示成明天，看着像被跳过去了。
        const nowMinute = new Date(now)
        nowMinute.setSeconds(0, 0)
        const nowMinuteMs = nowMinute.getTime()
        for (let d = 0; d <= 8; d++) {
          const t = new Date(now + d * 86400000)
          t.setHours(hh, mm, 0, 0)
          const ms = t.getTime()
          if (ms < nowMinuteMs) continue`,
)

// ---------------------------------------------------------------- E4c nextIn never negative
rep(
  'E4c nextIn clamp',
  `          entry.nextAt = ms
          entry.nextIn = ms - now
          break`,
  `          entry.nextAt = ms
          // 「就在这一分钟」时 nextAt 可能已经比 now 早几十秒，别显示负数
          entry.nextIn = Math.max(0, ms - now)
          break`,
)

// ---------------------------------------------------------------- E5 diag exposes the last check
rep(
  'E5 diag alarmChecks',
  `          // ⑤ 闹钟排程（本地时间）——到点没响时能一眼看出排程对不对
          alarms: alarmSchedule(),`,
  `          // ⑤ 闹钟排程（本地时间）+ 最近一次 20s 巡检 —— 到点没响时一眼看出卡在哪
          alarms: alarmSchedule(),
          alarmChecks: runtime.lastAlarmCheck,`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
