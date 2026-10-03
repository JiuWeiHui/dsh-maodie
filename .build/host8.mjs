// Host patch 8 (1.2.8): accept the frontend's input diagnostics in the heartbeat.
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

rep('N1 version', `const PLUGIN_VERSION = '1.2.7'`, `const PLUGIN_VERSION = '1.2.8'`)

rep(
  'N2 report whitelists inputDiag',
  `          // 前端「交付时自愈」的流水：非空说明「通知弹了却没声音」的配置被前端当场修好了`,
  `          // 前端的输入诊断时间线：焦点/按键/值变化/面板重建（排查「输不进去」）
          inputDiag: Array.isArray(body.inputDiag)
            ? body.inputDiag.slice(-20).map((x) => ({
                at: num(x && x.at),
                kind: clip(x && x.kind, 40),
                detail: clip(x && x.detail, 120),
                active: clip(x && x.active, 40),
                focused: x && x.focused === true,
              }))
            : [],
          // 前端「交付时自愈」的流水：非空说明「通知弹了却没声音」的配置被前端当场修好了`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
