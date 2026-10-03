// Frontend patch 6 (1.2.5): show the running versions in the settings title.
//
// The whole "又按不动了" round happened because the page was still running an older
// script than the one on disk, and nothing on screen said so. Now the settings title
// carries "前端 x.y.z · Host a.b.c" so a stale page is visible at a glance.
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

rep('G1 version', `  var MAODIE_VERSION = '1.2.4'`, `  var MAODIE_VERSION = '1.2.5'`)

rep(
  'G2 settings title shows versions',
  `    var title = el('div', 'md-set-title', '耄耋 · 设置')`,
  `    // 标题里带上「前端 / Host」两个版本：一眼就能看出页面跑的是不是磁盘上那一份
    // （踩过的坑：改了代码但页面还跑着旧脚本，看起来就像「越修越坏」）
    var title = el('div', 'md-set-title', '耄耋 · 设置')
    title.setAttribute('data-md-versions', '1')
    title.textContent =
      '耄耋 · 设置（前端 ' + MAODIE_VERSION + ' · Host ' + ((boot && boot.version) || '?') + '）'`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
