// Frontend patch 10 (1.2.9):
//   1. the settings window is no longer draggable — it is always centered. Dragging could
//      park it at the screen edge/under other UI ("卡到页面上面了") with no way back except
//      reopening; the header now just says "设置", cursor:default.
//   2. any inline position left over from a previous drag is cleared on open, so an
//      already-stuck window is rescued as soon as this version loads.
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

rep('O1 version', `  var MAODIE_VERSION = '1.2.8'`, `  var MAODIE_VERSION = '1.2.9'`)

// ---------------------------------------------------------------- O2 drop the drag
rep(
  'O2 settings window is fixed & centered',
  `    // 拖动窗口
    ;(function makeDraggable() {
      var dragging = null
      head.addEventListener('pointerdown', function (e) {
        if (e.target === close) return
        var r = win.getBoundingClientRect()
        dragging = { x: e.clientX - r.left, y: e.clientY - r.top }
        head.setPointerCapture && head.setPointerCapture(e.pointerId)
      })
      head.addEventListener('pointermove', function (e) {
        if (!dragging) return
        var w = win.getBoundingClientRect()
        var nx = clamp(e.clientX - dragging.x, 0, window.innerWidth - w.width)
        var ny = clamp(e.clientY - dragging.y, 0, window.innerHeight - 40)
        win.style.left = Math.round(nx) + 'px'
        win.style.top = Math.round(ny) + 'px'
        win.style.margin = '0'
      })
      head.addEventListener('pointerup', function (e) {
        dragging = null
        try {
          head.releasePointerCapture && head.releasePointerCapture(e.pointerId)
        } catch (err) {
          /* 忽略 */
        }
      })
    })()`,
  `    // 设置窗口固定居中、**不可拖动**：拖动会把它停在屏幕边缘/被别的界面盖住
    // （用户反馈「设置卡到那个页面上面了」），而且拖走之后很难再拉回来。
    // 这里清掉可能残留的 inline 位置，保证每次打开都居中。
    win.style.left = ''
    win.style.top = ''
    win.style.margin = ''
    win.style.transform = ''`,
)

rep(
  'O2b header cursor',
  `    '.md-set-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(32,49,112,.06);border-bottom:1px solid rgba(32,49,112,.14);cursor:move}',`,
  `    '.md-set-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(32,49,112,.06);border-bottom:1px solid rgba(32,49,112,.14);cursor:default}',`,
)

rep(
  'O2c reuse path also re-centers',
  `  function openSettings(tab) {
    if (settingsWin) {
      settingsWin.root.style.display = 'flex'
      if (tab) selectTab(tab)
      return
    }`,
  `  function openSettings(tab) {
    if (settingsWin) {
      // 复用时也把位置清干净：以前拖到屏幕边上的窗口，一打开就自动回到居中
      try {
        settingsWin.win.style.left = ''
        settingsWin.win.style.top = ''
        settingsWin.win.style.margin = ''
        settingsWin.win.style.transform = ''
      } catch (err) {
        /* 忽略 */
      }
      settingsWin.root.style.display = 'flex'
      if (tab) selectTab(tab)
      return
    }`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
