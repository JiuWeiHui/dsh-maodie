// Frontend patch 5 (1.2.4):
//   - setting a time on a disabled alarm now ENABLES it (the old confirm() could be
//     cancelled/missed, leaving an alarm that looks configured but never rings)
//   - "next fire" counts the current minute as due, so a freshly set time shows
//     "就在这一分钟内" instead of jumping to tomorrow ("直接跨过去")
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

rep('F1 version', `  var MAODIE_VERSION = '1.2.3'`, `  var MAODIE_VERSION = '1.2.4'`)

// ---------------------------------------------------------------- F2 current minute counts as due
rep(
  'F2 localNextFire minute floor',
  `    var now = nowMs || Date.now()
    for (var d = 0; d <= 8; d++) {
      var t = new Date(now + d * 86400000)
      t.setHours(hh, mm, 0, 0)
      var ms = t.getTime()
      if (ms <= now) continue`,
  `    var now = nowMs || Date.now()
    // 「就在这一分钟」也算还没到：闹钟是按分钟匹配的（Host 每 20s 巡检一次），
    // 刚设好时间时秒数已经走了一点，若按毫秒比较就会显示成明天 ——
    // 看起来就像「设了个时间它直接跨过去了」。
    var nowMinute = new Date(now)
    nowMinute.setSeconds(0, 0)
    var nowMinuteMs = nowMinute.getTime()
    for (var d = 0; d <= 8; d++) {
      var t = new Date(now + d * 86400000)
      t.setHours(hh, mm, 0, 0)
      var ms = t.getTime()
      if (ms < nowMinuteMs) continue`,
)
rep(
  'F2b alarmNextText due wording',
  `    var next = localNextFire(al, now)
    if (next === null) return '8 天内不会触发（检查时间 / 日期 / 星期）'
    var at = new Date(next)
    var hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
    return '下次 ' + hhmm + '（' + (at.getMonth() + 1) + '月' + at.getDate() + '日）· 还有 ' + fmtCountdown(next - now)`,
  `    var next = localNextFire(al, now)
    if (next === null) return '8 天内不会触发（检查时间 / 日期 / 星期）'
    var at = new Date(next)
    var hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
    if (next - now <= 60000) return '下次 ' + hhmm + '（就在这一分钟内，Host 每 20 秒巡检一次）'
    return '下次 ' + hhmm + '（' + (at.getMonth() + 1) + '月' + at.getDate() + '日）· 还有 ' + fmtCountdown(next - now)`,
)

// ---------------------------------------------------------------- F3 setting a time enables a disabled alarm
rep(
  'F3 time edit auto-enables',
  `      time.addEventListener('change', function () {
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
        // 只刷新「下次…」那行文字，绝不重建整行 ——
        // 时间选择器还开着的时候重建，输入就会直接丢掉
        refreshAlarmTicks()
      })`,
  `      time.addEventListener('change', function () {
        al.time = time.value
        // 停用状态下改时间 = 明确想让它响：直接一起启用。
        // （之前用 confirm() 问一句，结果弹窗被点掉/被面板重建吞掉时就留下
        //   一个「看起来配好了但永远不会响」的闹钟，正是踩过的坑。）
        if (al.enabled === false) {
          al.enabled = true
          try {
            if (enableBox) enableBox.checked = true
            if (noteEl) noteEl.textContent = '已随改时间自动启用'
          } catch (err) {
            /* 忽略 */
          }
        }
        persist()
        // 只刷新「下次…」那行文字，绝不重建整行 ——
        // 时间选择器还开着的时候重建，输入就会直接丢掉
        refreshAlarmTicks()
      })`,
)

// ---------------------------------------------------------------- F4 wire the checkbox + note elements
rep(
  'F4 enable box + note elements',
  `      item.appendChild(checkbox(al.enabled !== false, function (v) {
        al.enabled = v
        persist()
        refreshAlarmTicks()
      }))
      item.appendChild(el('span', 'md-dim', '启用'))`,
  `      var noteEl = el('span', 'md-dim', '')
      var enableBox = checkbox(al.enabled !== false, function (v) {
        al.enabled = v
        if (noteEl) noteEl.textContent = v ? '已启用' : '已停用：不会响'
        persist()
        refreshAlarmTicks()
      })
      item.appendChild(enableBox)
      item.appendChild(el('span', 'md-dim', '启用'))
      item.appendChild(noteEl)`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
