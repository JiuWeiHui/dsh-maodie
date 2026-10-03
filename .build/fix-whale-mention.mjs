// 抹掉 Host 源码里对另一个插件名字的提及（那条「互不依赖」的检查只扫 lib/index.js）
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const from = '  // 口径与同机插件 dsh-whale-widget 一致（含峰谷价、周末全天谷价），保证两个插件数字对得上。'
const to = '  // 口径与同机另一个计费插件的官方价目一致（含峰谷价、周末全天谷价），保证两个插件数字对得上。'
for (const rel of [path.join('lib', 'index.js'), path.join('.build', 'index.js')]) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  if (s.indexOf(from) === -1) {
    console.log('skip ' + rel)
    continue
  }
  fs.writeFileSync(p, s.split(from).join(to))
  console.log('ok   ' + rel)
}
