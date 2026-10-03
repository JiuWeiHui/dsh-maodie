// Small follow-up patch: add the one-click "enable slots that have sounds but are switched off"
// button to the sound-warning box. Runs against an otherwise-finished frontend.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'frontend.js')

let s = fs.readFileSync(TARGET, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')

const from = `    var warns = soundWarningsLocal()
    if (warns.length > 0) {
      var warnBox = el('div', 'md-warn')
      warns.forEach(function (w) {
        warnBox.appendChild(el('div', null, '⚠️ ' + w))
      })
      pane.appendChild(warnBox)
    }`
const to = `    var warns = soundWarningsLocal()
    if (warns.length > 0) {
      var warnBox = el('div', 'md-warn')
      warns.forEach(function (w) {
        warnBox.appendChild(el('div', null, '⚠️ ' + w))
      })
      // 「为什么没声音」里最常见的一种：槽位配了素材但没勾启用 —— 一键修好
      warnBox.appendChild(
        button('一键启用「配了素材但没勾启用」的槽位', 'md-btn-mini', function () {
          var fixed = 0
          ;((state.audio && state.audio.slots) || []).forEach(function (sl) {
            if (sl && sl.enabled === false && sl.sounds && sl.sounds.length > 0) {
              sl.enabled = true
              fixed += 1
            }
          })
          if (state.notify && state.notify.turnEnd && state.notify.turnEnd.enabled === false) {
            state.notify.turnEnd.enabled = true
          }
          persist()
          renderAudioPane()
          if (typeof alert === 'function') {
            alert(fixed > 0 ? '已启用 ' + fixed + ' 个槽位' : '没有需要修复的槽位（看看上面的提示）')
          }
        }),
      )
      pane.appendChild(warnBox)
    }`

const n = s.split(from).length - 1
if (n !== 1) {
  console.error('MISMATCH [warn fix button] found=' + n)
  process.exit(1)
}
s = s.split(from).join(to)
fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('ok  warn fix button; written', s.length, 'chars')
