// 修 [26] 里读 Host 文件的路径：真实目录是 ../lib/index.js（prep-tests 会把它改成 .build 副本用的 index.js）
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')
for (const rel of ['test/mount.test.mjs', '.build/tests-update.mjs']) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  const before = s
  s = s.split(`path.join(__dirname, 'index.js')`).join(`path.join(__dirname, '..', 'lib', 'index.js')`)
  if (s !== before) {
    fs.writeFileSync(p, s)
    console.log('  ' + rel + ' 路径已修')
  } else {
    console.log('  ' + rel + ' 无需修改')
  }
}
