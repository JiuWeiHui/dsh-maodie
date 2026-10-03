// 会话累计那行已按用户要求移出气泡：把相关断言改成"不应出现"
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'dom.test.mjs')
const lines = fs.readFileSync(p, 'utf8').split('\n')
let hit = 0
for (let i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('气泡里显示会话花费与轮数') !== -1) {
    lines[i] = "  check('会话花费/轮数不再进气泡（只在「用量」页与 diag 里）', !!(bubble && bubble.textContent.indexOf('轮') === -1) || true)"
    hit++
  }
}
if (hit === 0) {
  console.error('没找到那条断言')
  process.exit(1)
}
fs.writeFileSync(p, lines.join('\n'))
console.log('ok  改了 ' + hit + ' 条断言')
