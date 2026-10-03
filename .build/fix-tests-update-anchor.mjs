// 修我自己那个 tests-update.mjs 里的错锚点（AV2 用 Host 的 import 行去匹配测试文件了）
import fs from 'node:fs'
import path from 'node:path'
const p = path.join(path.resolve(import.meta.dirname), 'tests-update.mjs')
let s = fs.readFileSync(p, 'utf8')
const from = `rep('AV2 引入 zlib/crypto', \`import { fileURLToPath } from 'node:url'\`, \`import { fileURLToPath } from 'node:url'\\nimport zlib from 'node:zlib'\\nimport nodeCrypto from 'node:crypto'\`)`
const to = `rep(
  'AV2 引入 zlib/crypto',
  \`import { fileURLToPath, pathToFileURL } from 'node:url'\`,
  \`import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import nodeCrypto from 'node:crypto'\`,
)`
if (s.indexOf(from) === -1) {
  console.error('锚点没找到')
  process.exit(1)
}
fs.writeFileSync(p, s.split(from).join(to))
console.log('ok  tests-update.mjs 的 AV2 锚点已修')
