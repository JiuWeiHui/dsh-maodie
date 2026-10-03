// Frontend patch 2 (1.2.1): live, locally-computed alarm countdown + disabled-state clarity.
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

// ---------------------------------------------------------------- F1 version
rep('F1 version', `  var MAODIE_VERSION = '1.2.0'`, `  var MAODIE_VERSION = '1.2.1'`)

// ---------------------------------------------------------------- F2 local next-fire helpers
rep(
  'F2 alarm helpers',
  `  // 上传自己的外观图：先在本地算好包围盒，再一次性交给 Host
  function pickImageFile() {`,
  `  // ------------------------------------------------------------ 闹钟排程（本地时间，前端自己算）
  // 为什么在前端算：改完时间要**立刻**反映，不能等 Host 的 30s 状态轮询；
  // 而且「下次 xx 小时 yy 分后」要每秒自己走。口径与 Host 的 alarmSchedule 一致：
  // 本地时间、每天/一次性、可选星期，最多往后看 8 天。
  function fmtCountdown(ms) {
    var total = Math.max(0, Math.floor(ms / 1000))
    var d = Math.floor(total / 86400)
    var h = Math.floor((total % 86400) / 3600)
    var mi = Math.floor((total % 3600) / 60)
    var se = total % 60
    if (d > 0) return d + ' 天 ' + h + ' 小时 ' + mi + ' 分'
    if (h > 0) return h + ' 小时 ' + mi + ' 分 ' + se + ' 秒'
    if (mi > 0) return mi + ' 分 ' + se + ' 秒'
    return se + ' 秒'
  }

  function localNextFire(al, nowMs) {
    if (!al || al.enabled === false) return null
    var m = /^(\\d{1,2}):(\\d{2})$/.exec(String(al.time || ''))
    if (!m) return null
    var hh = Number(m[1])
    var mm = Number(m[2])
    var now = nowMs || Date.now()
    for (var d = 0; d <= 8; d++) {
      var t = new Date(now + d * 86400000)
      t.setHours(hh, mm, 0, 0)
      var ms = t.getTime()
      if (ms <= now) continue
      if (al.mode === 'once' && al.date) {
        var pad = function (n) {
          return String(n).padStart(2, '0')
        }
        if (t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) !== al.date) continue
      }
      if (al.mode === 'daily' && Array.isArray(al.weekdays) && al.weekdays.length > 0) {
        if (al.weekdays.indexOf(t.getDay()) === -1) continue
      }
      return ms
    }
    return null
  }

  function alarmNextText(al, nowMs) {
    var now = nowMs || Date.now()
    if (!al) return ''
    if (al.enabled === false) return '⏸ 已停用：勾上「启用」才会响'
    var next = localNextFire(al, now)
    if (next === null) return '8 天内不会触发（检查时间 / 日期 / 星期）'
    var at = new Date(next)
    var hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
    return '下次 ' + hhmm + '（' + (at.getMonth() + 1) + '月' + at.getDate() + '日）· 还有 ' + fmtCountdown(next - now)
  }

  // 每秒刷一次所有闹钟的「下次…」文本：只改文字，不重建 DOM，改完时间立刻能看到
  function refreshAlarmTicks() {
    try {
      var nodes = document.querySelectorAll('[data-md-alarm-next]')
      if (nodes.length === 0) return
      var now = Date.now()
      var alarms = state.alarms || []
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var id = node.getAttribute('data-md-alarm-next')
        var found = null
        for (var j = 0; j < alarms.length; j++) {
          if (alarms[j] && String(alarms[j].id) === id) {
            found = alarms[j]
            break
          }
        }
        node.textContent = found ? alarmNextText(found, now) : '闹钟已删除'
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  // 上传自己的外观图：先在本地算好包围盒，再一次性交给 Host
  function pickImageFile() {`,
)

// ---------------------------------------------------------------- F3 ticker
rep(
  'F3 ticker',
  `    setInterval(pollInbox, 5000)
    setInterval(sendReport, 15000)`,
  `    setInterval(pollInbox, 5000)
    setInterval(sendReport, 15000)
    // 闹钟「下次…」倒计时：每秒自己走
    setInterval(refreshAlarmTicks, 1000)`,
)

// ---------------------------------------------------------------- F4 alarm item: local countdown + disabled clarity
rep(
  'F4 alarm item',
  `      var sched = schedule.filter(function (x) {
        return x && x.id === al.id
      })[0]
      if (sched && sched.nextAt) {
        item.appendChild(el('span', 'md-dim', '下次 ' + fmtDuration(sched.nextAt - Date.now()) + '后'))
      }`,
  `      // 「下次…」在前端本地算，改完时间立刻反映（Host 的排程只在 /maodie/diag 里做交叉验证）
      var nextLine = el('span', 'md-dim', alarmNextText(al, Date.now()))
      nextLine.setAttribute('data-md-alarm-next', String(al.id))
      item.appendChild(nextLine)`,
)

// ---------------------------------------------------------------- F5 time edit: prompt to enable when disabled
rep(
  'F5 time edit',
  `      var time = el('input')
      time.type = 'time'
      time.value = al.time || '09:00'
      time.addEventListener('change', function () {
        al.time = time.value
        persist()
      })
      item.appendChild(time)`,
  `      var time = el('input')
      time.type = 'time'
      time.value = al.time || '09:00'
      time.addEventListener('change', function () {
        al.time = time.value
        // 停用状态下改时间多半是想让它响起来 —— 问一句，而不是静默地什么都不发生
        if (al.enabled === false) {
          var ok = true
          try {
            ok = window.confirm('这个闹钟现在是「已停用」状态，改完时间也不会响。要同时启用吗？')
          } catch (err) {
            ok = true
          }
          if (ok) al.enabled = true
        }
        persist()
        refreshAlarmTicks()
        renderPeakPane()
      })
      item.appendChild(time)`,
)

// ---------------------------------------------------------------- F6 enable checkbox refreshes the countdown
rep(
  'F6 enable checkbox',
  `      item.appendChild(checkbox(al.enabled !== false, function (v) {
        al.enabled = v
        persist()
      }))
      item.appendChild(el('span', 'md-dim', '启用'))`,
  `      item.appendChild(checkbox(al.enabled !== false, function (v) {
        al.enabled = v
        persist()
        refreshAlarmTicks()
        renderPeakPane()
      }))
      item.appendChild(el('span', 'md-dim', '启用'))`,
)

// ---------------------------------------------------------------- F7 mode/date edits refresh too
rep(
  'F7 mode edit',
  `      mode.addEventListener('change', function () {
        al.mode = mode.value
        persist()
        renderPeakPane()
      })`,
  `      mode.addEventListener('change', function () {
        al.mode = mode.value
        persist()
        refreshAlarmTicks()
        renderPeakPane()
      })`,
)
rep(
  'F7b date edit',
  `        date.addEventListener('change', function () {
          al.date = date.value
          persist()
        })`,
  `        date.addEventListener('change', function () {
          al.date = date.value
          persist()
          refreshAlarmTicks()
        })`,
)

// ---------------------------------------------------------------- F8 render the list then tick once
rep(
  'F8 tick after render',
  `    pane.appendChild(alarmList)
    pane.appendChild(button('＋ 新增闹钟', 'md-btn-primary', function () {`,
  `    pane.appendChild(alarmList)
    refreshAlarmTicks()
    pane.appendChild(button('＋ 新增闹钟', 'md-btn-primary', function () {`,
)

// ---------------------------------------------------------------- F9 sound warning text mentions the self-heal
rep(
  'F9 warning wording',
  `    if (!hasPool('turn.end')) out.push('没有任何可用槽位绑定 turn.end → 任务完成不会出声')
    if (!hasPool('alarm.fire')) out.push('没有任何可用槽位绑定 alarm.fire → 闹钟不会出声')`,
  `    if (!hasPool('turn.end')) out.push('没有任何可用槽位绑定 turn.end → 任务完成不会出声（点下面的按钮一键修好）')
    if (!hasPool('alarm.fire')) out.push('没有任何可用槽位绑定 alarm.fire → 闹钟不会出声（点下面的按钮一键修好）')`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
