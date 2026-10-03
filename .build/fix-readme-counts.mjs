// README 计数同步到 1.3.1（上一条命令里 PowerShell 把引号吃掉了，改用脚本文件）
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), 'README.md')
let s = fs.readFileSync(p, 'utf8')
const before = s
s = s.split('**229 项通过 / 0 失败**').join('**231 项通过 / 0 失败**')
s = s.split('**152 项通过，0 页面异常**').join('**156 项通过，0 页面异常**')
if (s === before) {
  console.log('计数已经是新的了，无需改动')
} else {
  fs.writeFileSync(p, s)
  console.log('ok  README 计数 -> 231 / 68 / 156')
}
