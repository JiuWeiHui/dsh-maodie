// 1.3.3：包名改成 dsh-maodie（npm 用）+ 补齐 npm 元数据 + bundle patch 的模块名
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

function patch(rel, edits) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  const eol = s.includes('\r\n') ? '\r\n' : '\n'
  s = s.split('\r\n').join('\n')
  for (const [name, from, to, expect = 1] of edits) {
    const n = s.split(from).length - 1
    if (n !== expect) {
      console.error('MISMATCH [' + rel + ' ' + name + '] found=' + n + ' expected=' + expect)
      process.exit(1)
    }
    s = s.split(from).join(to)
    console.log('ok  ' + rel + ' :: ' + name)
  }
  fs.writeFileSync(p, s.split('\n').join(eol))
}

// 1) package.json：改名 + 补 npm 元数据 + 让 npm 包里带上第三方声明
patch('package.json', [
  ['P1 包名', `  "name": "maodie",`, `  "name": "dsh-maodie",`],
  [
    'P2 npm 元数据 + files',
    `  "files": [
    "lib",
    "assets",
    "cordis.patch.yml",
    "README.md"
  ],`,
    `  "files": [
    "lib",
    "assets",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/JiuWeiHui/dsh-maodie.git"
  },
  "homepage": "https://github.com/JiuWeiHui/dsh-maodie#readme",
  "bugs": {
    "url": "https://github.com/JiuWeiHui/dsh-maodie/issues"
  },
  "author": "JiuWeiHui",`,
  ],
])

// 2) bundle patch：加载行的模块名跟着改（id 保持 maodie，不影响 profile 里的开关）
patch('cordis.patch.yml', [
  [
    'P3 bundle 模块名',
    `- insert:
    - id: maodie
      name: maodie`,
    `- insert:
    - id: maodie
      name: dsh-maodie`,
  ],
])

// 3) README：安装段补上 npm 安装方式
const rp = path.join(ROOT, 'README.md')
let s = fs.readFileSync(rp, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')
const anchor = '## 仓库与版本'
if (s.indexOf(anchor) === -1) {
  console.error('README 锚点没找到')
  process.exit(1)
}
const block = `## 安装（三种方式）

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| **npm（推荐，给别人用）** | \`dsh plugin add dsh-maodie\` | 已发布到 npm，装完重启桌面端一次 |
| **本地目录（开发用）** | \`plugin_manager { action: "install_bundle", target: "link:<插件目录>" }\` | HMR 打开时立刻生效；注入表变更仍需重启一次 |
| **Git 直装** | \`pnpm add github:JiuWeiHui/dsh-maodie\` | 不想走 npm 时可用 |

${anchor}`
s = s.split(anchor).join(block)
fs.writeFileSync(rp, s.split('\n').join(eol))
console.log('ok  README 补安装方式')

// 4) 版本号：1.3.2 -> 1.3.3（三处对齐：package.json / PLUGIN_VERSION / MAODIE_VERSION）
for (const rel of ['lib/index.js', 'assets/maodie.js', '.build/index.js', '.build/frontend.js']) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) continue
  let t = fs.readFileSync(p, 'utf8')
  const before = t
  t = t.split(`PLUGIN_VERSION = '1.3.2'`).join(`PLUGIN_VERSION = '1.3.3'`)
  t = t.split(`MAODIE_VERSION = '1.3.2'`).join(`MAODIE_VERSION = '1.3.3'`)
  if (t !== before) {
    fs.writeFileSync(p, t)
    console.log('ok  ' + rel + ' -> 1.3.3')
  }
}
const pj = path.join(ROOT, 'package.json')
fs.writeFileSync(pj, fs.readFileSync(pj, 'utf8').split('"version": "1.3.2"').join('"version": "1.3.3"'))
console.log('ok  package.json -> 1.3.3')
