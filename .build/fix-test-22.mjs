// 修测试里两处：1) 全局替换误伤的「原有路由清单」那一行；2) [22] 的调试详情
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'mount.test.mjs')
let s = fs.readFileSync(p, 'utf8')

const a1 = "  '/maodie/turn.json',\n  '/maodie/holidays.json',"
const b1 = "  '/maodie/usage.json',\n  '/maodie/holidays.json',"
if (s.indexOf(a1) !== -1) {
  s = s.split(a1).join(b1)
  console.log('ok  还原路由清单那一行')
} else {
  console.log('skip 路由清单那一行（没找到）')
}

const a2 = "    String(usage.turn && usage.turn.tokens),"
const b2 = "    'DEBUG2 ' + JSON.stringify(usage.turn),"
if (s.indexOf(a2) !== -1) {
  s = s.split(a2).join(b2)
  console.log('ok  [22] 详情改成 dump')
} else {
  console.log('skip [22] 详情（没找到）')
}

fs.writeFileSync(p, s)
console.log('turn.json 次数 =', (s.match(/\/maodie\/turn\.json/g) || []).length, '| usage.json 次数 =', (s.match(/\/maodie\/usage\.json/g) || []).length)
