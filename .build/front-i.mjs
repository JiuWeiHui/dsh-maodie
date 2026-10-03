// Frontend patch 7 (1.2.6): the alarm safety net.
//
// The Host's 20s sweep is the thing that decides "it is time" — and it turned out never
// to have run at all (/maodie/diag: alarmChecks was null for hours), while the manual
// test button worked because it calls the delivery function directly. So the page now
// watches the clock itself: in the minute an enabled alarm is due, if no alarm event has
// arrived yet, it pokes POST /maodie/alarm-fire.json. The Host dedupes per alarm+minute,
// so this can never cause a double ring.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'frontend.js')

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

rep('J1 version', `  var MAODIE_VERSION = '1.2.5'`, `  var MAODIE_VERSION = '1.2.6'`)

// ---------------------------------------------------------------- J2 watchdog
rep(
  'J2 alarm watchdog',
  `        node.textContent = found ? alarmNextText(found, now) : '闹钟已删除'
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  // 上传自己的外观图：先在本地算好包围盒，再一次性交给 Host`,
  `        node.textContent = found ? alarmNextText(found, now) : '闹钟已删除'
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  // ------------------------------------------------------------ 闹钟兜底（前端补一枪）
  // 血坑：Host 侧的 20 秒巡检因为定时器注册失败**从来没跑过**（diag 里 alarmChecks 一直是
  // null），而「立即测试」是直接投递，所以一切看起来正常 —— 到点就是不响。
  // 现在前端自己也盯时钟：到点那一分钟如果还没收到 Host 的 alarm 事件，就请 Host 投一次
  // （POST /maodie/alarm-fire.json）。Host 按「闹钟+分钟」幂等去重，所以两边同时动作也不会重复响。
  // 前端**不自己出声**，只负责把 Host 叫醒，保证只有一条投递链路。
  var MD_ALARM_GRACE_MS =
    typeof window.__MD_ALARM_GRACE_MS === 'number' ? window.__MD_ALARM_GRACE_MS : 25000
  var alarmWatch = { lastCheck: 0, pokes: [], fired: {} }

  function mdPad2(n) {
    return String(n).padStart(2, '0')
  }

  function mdMinuteKey(id, d) {
    return String(id) + '@' + mdPad2(d.getHours()) + ':' + mdPad2(d.getMinutes())
  }

  // Host 的闹钟事件到了 → 这一分钟就不需要兜底了
  function noteAlarmFired(data) {
    try {
      if (!data || data.id === undefined || data.id === null) return
      alarmWatch.fired[mdMinuteKey(data.id, new Date())] = Date.now()
    } catch (err) {
      /* 忽略 */
    }
  }

  function alarmWatchdog() {
    try {
      var alarms = (state && state.alarms) || []
      var d = new Date()
      var hhmm = mdPad2(d.getHours()) + ':' + mdPad2(d.getMinutes())
      // 只保留当前这一分钟的记录，别让它无限增长
      for (var k in alarmWatch.fired) {
        if (k.slice(-5) !== hhmm) delete alarmWatch.fired[k]
      }
      alarmWatch.lastCheck = Date.now()
      if (alarms.length === 0) return
      var elapsed = d.getSeconds() * 1000 + d.getMilliseconds()
      if (elapsed < MD_ALARM_GRACE_MS) return
      for (var i = 0; i < alarms.length; i++) {
        var al = alarms[i]
        if (!al || al.enabled === false) continue
        if (String(al.time || '') !== hhmm) continue
        var key = mdMinuteKey(al.id, d)
        if (alarmWatch.fired[key]) continue
        alarmWatch.fired[key] = Date.now()
        alarmWatch.pokes.push({ id: String(al.id), time: hhmm, at: Date.now() })
        if (alarmWatch.pokes.length > 20) alarmWatch.pokes = alarmWatch.pokes.slice(-20)
        json(api('/alarm-fire.json'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: String(al.id) }),
        }).catch(function () {})
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  // 上传自己的外观图：先在本地算好包围盒，再一次性交给 Host`,
)

// ---------------------------------------------------------------- J3 record incoming alarm events
rep(
  'J3 noteAlarmFired on event',
  `    if (payload.type === 'alarm') {
      var d = payload.data || {}`,
  `    if (payload.type === 'alarm') {
      var d = payload.data || {}
      noteAlarmFired(d)`,
)

// ---------------------------------------------------------------- J4 start the watchdog
rep(
  'J4 start watchdog',
  `    // 闹钟「下次…」倒计时：每秒自己走
    setInterval(refreshAlarmTicks, 1000)`,
  `    // 闹钟「下次…」倒计时：每秒自己走
    setInterval(refreshAlarmTicks, 1000)
    // 闹钟兜底：到点那一分钟如果 Host 没动静，就请它投一次（Host 侧幂等，不会重复响）
    alarmWatchdog()
    setInterval(alarmWatchdog, 3000)`,
)

// ---------------------------------------------------------------- J5 report the watchdog state
rep(
  'J5 report alarmWatch',
  `      inbox: {
        boot: evState.boot,
        lastSeq: evState.lastSeq,
        lastPollAt: evState.inbox.lastPollAt,
        polls: evState.inbox.polls,
        errors: evState.inbox.errors,
      },`,
  `      inbox: {
        boot: evState.boot,
        lastSeq: evState.lastSeq,
        lastPollAt: evState.inbox.lastPollAt,
        polls: evState.inbox.polls,
        errors: evState.inbox.errors,
      },
      // 闹钟兜底的状态：前端有没有替 Host 补过枪、最后一次检查是什么时候
      alarmWatch: { lastCheck: alarmWatch.lastCheck, pokes: alarmWatch.pokes.slice(-5) },`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
