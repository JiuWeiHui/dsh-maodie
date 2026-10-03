// Host patch 6 (1.2.6) — the actual alarm root cause.
//
// The 20s alarm sweep was registered with `ctx.setInterval(...)` inside a try/catch that
// swallowed the error. /maodie/diag proved `alarmChecks` was still null hours later:
// the sweep had NEVER run. "立即测试整条链路" calls deliverAlarm() directly, so it
// always worked — which is exactly the reported symptom.
//
// Fixes:
//   - register the sweep with the Host process's own global setInterval (deterministic),
//     record the registration + a tick counter in diag so "it isn't running" is visible
//   - `fireAlarmOnce(alarm)`: one idempotent delivery path used by both the sweep and
//     the new /maodie/alarm-fire.json route (a per-minute dedupe makes double firing
//     impossible, so the frontend can safely poke the Host as a safety net)
//   - /maodie/diag?runAlarmSweep=1 runs the sweep on demand (diagnostics AND tests)
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

rep('I1 version', `const PLUGIN_VERSION = '1.2.5'`, `const PLUGIN_VERSION = '1.2.6'`)

// ---------------------------------------------------------------- I2 runtime timer bookkeeping
rep(
  'I2 runtime timer bookkeeping',
  `    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底。`,
  `    // 定时器登记与心跳：闹钟巡检「到底跑没跑」必须能在 diag 里直接看到
    timers: [],
    timerTicks: {},
    timerErrors: {},
    // 事件双通道：SSE 即时送达 + 收件箱轮询兜底。`,
)

// ---------------------------------------------------------------- I3 fireAlarmOnce + refactor sweep
rep(
  'I3 fireAlarmOnce',
  `  const checkAlarms = () => {
    const alarms = Array.isArray(state.alarms) ? state.alarms : []
    if (alarms.length === 0) return
    const parts = localParts(Date.now())
    const hhmm = parts.hhmm
    const stamp = \`\${parts.date} \${hhmm}\`
    runtime.lastAlarmCheck = { at: Date.now(), hhmm, date: parts.date, fired: [] }
    for (const alarm of alarms) {
      if (!alarm || alarm.enabled === false) continue
      const time = alarmTimeKey(alarm.time)
      if (time === '' || time !== hhmm) continue
      // 同一分钟内只触发一次
      if (runtime.alarmFiredThisMinute.has(alarm.id + '@' + stamp)) continue
      // 一次性闹钟只在指定日期触发
      if (alarm.mode === 'once' && alarm.date && alarm.date !== parts.date) continue
      // 每天模式可限制星期
      if (alarm.mode === 'daily' && Array.isArray(alarm.weekdays) && alarm.weekdays.length > 0) {
        if (!alarm.weekdays.includes(parts.weekday)) continue
      }
      runtime.alarmFiredThisMinute.add(alarm.id + '@' + stamp)
      // 一次性闹钟触发后自动停用
      if (alarm.mode === 'once') alarm.enabled = false
      runtime.lastAlarmCheck.fired.push(deliverAlarm(alarm, false))
    }
    saveState()
  }`,
  `  // 闹钟投递的**唯一入口**（定时巡检、前端兜底、诊断手动跑都走它）：
  // 同一分钟内同一个闹钟只会投一次，所以「巡检」和「前端补一枪」同时发生也不会重复响。
  const fireAlarmOnce = (alarm, isTest) => {
    if (!alarm) return { ok: false, reason: 'no-alarm' }
    const parts = localParts(Date.now())
    const hhmm = parts.hhmm
    const stamp = \`\${parts.date} \${hhmm}\`
    const key = String(alarm.id) + '@' + stamp
    if (runtime.alarmFiredThisMinute.has(key)) {
      return { ok: true, alreadyFired: true, time: hhmm }
    }
    // 一次性闹钟只在指定日期触发
    if (alarm.mode === 'once' && alarm.date && alarm.date !== parts.date) {
      return { ok: false, reason: 'not-today', time: hhmm }
    }
    // 每天模式可限制星期
    if (alarm.mode === 'daily' && Array.isArray(alarm.weekdays) && alarm.weekdays.length > 0) {
      if (!alarm.weekdays.includes(parts.weekday)) {
        return { ok: false, reason: 'not-this-weekday', time: hhmm }
      }
    }
    runtime.alarmFiredThisMinute.add(key)
    // 一次性闹钟触发后自动停用
    if (alarm.mode === 'once') alarm.enabled = false
    const delivered = deliverAlarm(alarm, isTest === true)
    return { ok: true, delivered, time: hhmm }
  }

  const checkAlarms = () => {
    const alarms = Array.isArray(state.alarms) ? state.alarms : []
    if (alarms.length === 0) return
    const parts = localParts(Date.now())
    const hhmm = parts.hhmm
    runtime.lastAlarmCheck = { at: Date.now(), hhmm, date: parts.date, checked: alarms.length, fired: [] }
    for (const alarm of alarms) {
      if (!alarm || alarm.enabled === false) continue
      const time = alarmTimeKey(alarm.time)
      if (time === '' || time !== hhmm) continue
      const out = fireAlarmOnce(alarm, false)
      if (out && out.delivered) runtime.lastAlarmCheck.fired.push(out.delivered)
    }
    saveState()
  }`,
)

// ---------------------------------------------------------------- I4 global timers + bookkeeping
rep(
  'I4 global timers',
  `    // —— 定时器：闹钟检查 + 余额刷新 ——
    const tick = () => {
      try {
        checkAlarms()
      } catch (err) {
        /* 忽略 */
      }
    }
    try {
      if (typeof ctx.setInterval === 'function') disposers.push(ctx.setInterval(tick, 20000))
      else {
        const t = setInterval(tick, 20000)
        disposers.push(() => clearInterval(t))
      }
    } catch (err) {
      /* 忽略 */
    }

    const balanceTick = () => {
      fetchBalance().catch(() => {})
    }
    try {
      if (typeof ctx.setInterval === 'function') disposers.push(ctx.setInterval(balanceTick, 60000))
      else {
        const t = setInterval(balanceTick, 60000)
        disposers.push(() => clearInterval(t))
      }
    } catch (err) {
      /* 忽略 */
    }`,
  `    // —— 定时器：闹钟巡检 + 余额刷新 ——
    // 血坑：原来这里用 \`ctx.setInterval(...)\` 注册，而且外面套了 try/catch、
    // catch 里什么都不做。结果定时器**从来没跑过**（diag 里 alarmChecks 一直是 null），
    // 而「立即测试」走的是直接投递，所以看起来一切正常 —— 闹钟到点永远不响。
    // 现在：直接用 Host 进程的全局 setInterval（语义最确定），并且把「注册结果 + 跑了几次
    // + 报错」全部记进 diag，让「没在跑」无处可藏。
    const every = (label, ms, fn) => {
      try {
        const timer = setInterval(() => {
          runtime.timerTicks[label] = (runtime.timerTicks[label] || 0) + 1
          try {
            fn()
          } catch (err) {
            runtime.timerErrors[label] = String((err && err.message) || err)
          }
        }, ms)
        disposers.push(() => {
          try {
            clearInterval(timer)
          } catch (err) {
            /* 忽略 */
          }
        })
        runtime.timers.push({ label, ms, mode: 'global', startedAt: Date.now() })
        return true
      } catch (err) {
        runtime.timers.push({ label, ms, mode: 'global', error: String((err && err.message) || err) })
        return false
      }
    }
    every('alarm', 20000, checkAlarms)
    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
    })
    const balanceTick = () => {
      fetchBalance().catch(() => {})
    }`,
)

// ---------------------------------------------------------------- I5 alarm-fire route + diag hook
rep(
  'I5 alarm-fire route',
  `    // —— 闹钟自测：立刻走一遍完整的闹钟投递链路（设置页用，不用等到点）——`,
  `    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/alarm-fire.json',
      handler: async (req, res) => {
        const body = await readBody(req, 1 << 20)
        const id = isPlainObject(body) ? String(body.id || '') : ''
        const alarms = Array.isArray(state.alarms) ? state.alarms : []
        const alarm = alarms.find((a) => a && String(a.id) === id)
        if (!alarm) {
          sendJson(res, 404, { ok: false, error: 'not-found', id })
          return
        }
        if (alarm.enabled === false) {
          sendJson(res, 200, { ok: false, error: 'disabled', id })
          return
        }
        const out = fireAlarmOnce(alarm, false)
        sendJson(
          res,
          200,
          Object.assign({ id, sseClients: runtime.sseClients.size, eventSeq: runtime.eventSeq }, out),
        )
      },
    })

    // —— 闹钟自测：立刻走一遍完整的闹钟投递链路（设置页用，不用等到点）——`,
)

rep(
  'I5b diag runAlarmSweep hook',
  `      handler: (req, res) => {
        const renderIndex =
          ctx.webServer && typeof ctx.webServer.renderIndex === 'function'`,
  `      handler: (req, res) => {
        // ?runAlarmSweep=1 手动跑一次闹钟巡检（诊断 / 测试用，不改任何配置）
        try {
          if (/[?&]runAlarmSweep=1/.test(req.url || '')) checkAlarms()
        } catch (err) {
          runtime.timerErrors.manualSweep = String((err && err.message) || err)
        }
        const renderIndex =
          ctx.webServer && typeof ctx.webServer.renderIndex === 'function'`,
)

// ---------------------------------------------------------------- I7 report whitelists alarmWatch
rep(
  'I7 report alarmWatch',
  `          errors: Array.isArray(body.errors) ? body.errors.slice(0, 10).map((e) => clip(e, 300)) : [],
        }`,
  `          errors: Array.isArray(body.errors) ? body.errors.slice(0, 10).map((e) => clip(e, 300)) : [],
          // 前端闹钟兜底的状态（它有没有替 Host 补过枪、最后一次检查是什么时候）
          alarmWatch: isPlainObject(body.alarmWatch)
            ? {
                lastCheck: num(body.alarmWatch.lastCheck),
                pokes: Array.isArray(body.alarmWatch.pokes)
                  ? body.alarmWatch.pokes.slice(0, 5).map((x) => ({
                      id: clip(x && x.id, 60),
                      time: clip(x && x.time, 10),
                      at: num(x && x.at),
                    }))
                  : [],
              }
            : { lastCheck: 0, pokes: [] },
        }`,
)

// ---------------------------------------------------------------- I6 diag exposes timers
rep(
  'I6 diag timers',
  `          // ③ 事件通道：SSE 客户端数 / 收件箱序号（闹钟与任务完成走这两条通道）`,
  `          // ③ 定时器：闹钟巡检到底有没有在跑（曾经这里是「从来没跑过」的现场）
          timers: runtime.timers,
          timerTicks: runtime.timerTicks,
          timerErrors: runtime.timerErrors,
          // ③b 事件通道：SSE 客户端数 / 收件箱序号（闹钟与任务完成走这两条通道）`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
