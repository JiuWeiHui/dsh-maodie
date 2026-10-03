// README 指向 INSTALL.md，然后提交推送
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')
const rp = path.join(ROOT, 'README.md')
let s = fs.readFileSync(rp, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')
const from = `| **Git 直装** | \`pnpm add github:JiuWeiHui/dsh-maodie\` | 不想走 npm 时可用 |`
const to = `${from}

> **具体「放到哪里 / 怎么装 / 升级卸载 / 常见问题」见 [INSTALL.md](INSTALL.md)**（含新电脑上缺少 API key、设置、素材的说明）。`
if (s.indexOf(from) === -1) {
  console.error('README 锚点没找到')
  process.exit(1)
}
s = s.split(from).join(to)
fs.writeFileSync(rp, s.split('\n').join(eol))
console.log('ok  README 已指向 INSTALL.md')
