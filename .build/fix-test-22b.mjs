// 修 [22] 里那条断言：current = 最近一次活动的供应商（B 的小米消息在最后），语义本来就是这样
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'mount.test.mjs')
let s = fs.readFileSync(p, 'utf8')
const a = `  check('usage.json 带当前供应商/模型', usage.current.provider === 'deepseek-official', JSON.stringify(usage.current))`
const b = `  // current = 最近一次模型活动的供应商（这里 B 的小米消息在最后，所以是 xiaomi）
  check(
    'usage.json 带当前供应商/模型（最近一次活动）',
    !!usage.current && usage.current.provider === 'xiaomi' && usage.current.model === 'mimo-v2.6-pro',
    JSON.stringify(usage.current),
  )`
if (s.indexOf(a) === -1) {
  console.error('anchor miss')
  process.exit(1)
}
fs.writeFileSync(p, s.split(a).join(b))
console.log('ok  断言修正')
