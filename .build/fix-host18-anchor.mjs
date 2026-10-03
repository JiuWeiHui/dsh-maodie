// 修 AC2 锚点：要连上一行一起锚，避免子串误命中 60 秒 tick 里那行
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), '.build', 'host18.mjs')
let s = fs.readFileSync(p, 'utf8')
const from = `rep(
  'AC2 启动刷自定义来源',
  \`    mdRefreshAccount().catch(() => {})\`,
  \`    mdRefreshAccount().catch(() => {})
    mdSyncModelSelection()
    mdRefreshCustomBalances().catch(() => {})\`,
)`
const to = `rep(
  'AC2 启动刷自定义来源',
  \`    mdRegisterProviders()
    mdRefreshAccount().catch(() => {})\`,
  \`    mdRegisterProviders()
    mdRefreshAccount().catch(() => {})
    mdSyncModelSelection()
    mdRefreshCustomBalances().catch(() => {})\`,
)`
if (s.indexOf(from) === -1) {
  console.error('锚点没找到')
  process.exit(1)
}
fs.writeFileSync(p, s.split(from).join(to))
console.log('ok  AC2 锚点改具体了')
