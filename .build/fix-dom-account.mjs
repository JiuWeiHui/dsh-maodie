// account 要在 status.providers.account 里（前端读的是这个层级）
import fs from 'node:fs'
import path from 'node:path'
const p = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'dom.test.mjs')
let s = fs.readFileSync(p, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')

const accountBlock = `  account: {
    available: true,
    signedIn: true,
    status: 'credential-stored',
    wallets: [{ currency: 'CNY', balance: 50 }],
    bonusWallets: [{ currency: 'CNY', balance: 5 }],
    usageUrl: 'https://platform.deepseek.com/usage',
    topUpUrl: 'https://platform.deepseek.com/top_up',
    updatedAt: Date.now(),
    error: '',
    source: 'DSH 登录账号（ctx.deepseekAccount）',
    linkedToProvider: false,
  },
`
if (s.indexOf(accountBlock) === -1) {
  console.error('顶层 account 没找到')
  process.exit(1)
}
// 1) 从顶层摘掉
s = s.split(accountBlock).join('')
// 2) 放进 providers 里（totals 之前，缩进改成 4 空格）
const indented = accountBlock
  .split('\n')
  .map((l) => (l.trim() === '' ? l : '  ' + l))
  .join('\n')
const anchor = `    totals: { todayTokens: 223332,`
if (s.indexOf(anchor) === -1) {
  console.error('providers.totals 锚点没找到')
  process.exit(1)
}
s = s.split(anchor).join(indented + anchor)
fs.writeFileSync(p, s.split('\n').join(eol))
console.log('ok  account 移到 providers 里了')
