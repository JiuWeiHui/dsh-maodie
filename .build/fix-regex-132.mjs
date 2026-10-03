// 修正中括号路径解析里的正则（字符类写错了）：同时修候选文件与补丁脚本
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

const bad = '.replace(/\\["\'?([^"\'\\]]+)["\'?\\]/g, \'.$1\')'
const good = '.replace(/\\[["\']?([^"\'\\]]+)["\']?\\]/g, \'.$1\')'

let n = 0
for (const rel of [path.join('.build', 'index.js'), path.join('.build', 'host18.mjs')]) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  if (s.indexOf(bad) === -1) {
    console.log('skip ' + rel)
    continue
  }
  s = s.split(bad).join(rel.endsWith('.mjs') ? '\\\\[["\']?([^"\'\\\\]]+)["\']?\\\\]' : good)
  fs.writeFileSync(p, s)
  n++
  console.log('ok   ' + rel)
}
if (n === 0) {
  console.error('两处都没找到，手动看一眼')
  process.exit(1)
}
