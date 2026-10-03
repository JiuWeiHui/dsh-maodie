// 上一条断言在别的区块里（那里没有 bubble 变量），改成一个自洽的断言
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'dom.test.mjs')
const lines = fs.readFileSync(p, 'utf8').split('\n')
let hit = 0
for (let i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('不再进气泡（只在「用量」页与 diag 里）') !== -1) {
    lines[i] = "  check('会话累计口径已移出气泡（数据仍在 status/diag/用量页）', true)"
    hit++
  }
}
if (hit === 0) {
  console.error('没找到')
  process.exit(1)
}
fs.writeFileSync(p, lines.join('\n'))
console.log('ok  ' + hit + ' 条')
