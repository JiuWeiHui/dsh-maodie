// 1.3.4 文档：README 计数 + 「检查更新」小节；INSTALL 补应用内更新
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
    console.log('  ' + rel + ' :: ' + name)
  }
  fs.writeFileSync(p, s.split('\n').join(eol))
}

patch('README.md', [
  ['计数：路由', '逐条请求 23 组路由 | **255 项通过 / 0 失败**', '逐条请求 26 组路由 | **282 项通过 / 0 失败**'],
  ['计数：前端', '**163 项通过，0 页面异常**', '**178 项通过，0 页面异常**'],
  [
    '新增「检查更新」小节',
    '## 仓库与版本',
    `### 检查更新与自动更新（1.3.4）

设置 → **关于** 里有更新面板：

| 能力 | 说明 |
| --- | --- |
| **检查更新** | 读 GitHub Releases（\`api.github.com/repos/JiuWeiHui/dsh-maodie/releases/latest\`，**国内可直连**，不需要代理），和本地版本做 semver 比较 |
| **何时检查** | 启动后查一次 + 每 6 小时一次；也可以随时点「检查更新」。可在面板里关掉自动检查 |
| **一键更新** | 点「立即更新」→ 先**预演**（列出将要覆盖的文件，让你确认）→ 下载 \`.tgz\` → **校验官方 sha256** → 解包 → **只覆盖运行必需文件**（\`lib/\`、\`assets/\`、\`cordis.patch.yml\`、README/LICENSE/NOTICES/package.json），**保留** \`.git\`、\`.build\`、\`test\` → 旧文件备份到 \`.update-backup-<旧版本>/\` → 提示「重启 DSH 生效」 |
| **自动安装** | 默认**关**。开启后检查到新版本会直接装（仍需重启 DSH）。面板里会提示这是不是 git 工作区 |
| **安全阀** | ① 下载内容 sha256 与官方不一致 → **中止且不动任何文件** ② 目标目录 \`package.json\` 名字不是 \`dsh-maodie\` → 拒绝 ③ 包里的 \`../\` 路径穿越被拒 ④ 预演模式只报告不写入 |

> 想回退：把 \`.update-backup-<版本>/\` 里的文件拷回去，或 \`git checkout .\`（如果你用 git 管理这份目录）。

## 仓库与版本`,
  ],
])

patch('INSTALL.md', [
  [
    '补应用内更新',
    '- **升级**：下载新版 zip → 解压**覆盖到同一个文件夹**（保持路径不变）→ 重启 DSH。路径没变就**不用重新安装**。',
    `- **升级（推荐）**：右键猫 → 设置 → **关于** → 「检查更新」→ 有新版本时点「立即更新」（会先列出要覆盖的文件让你确认，然后校验官方 sha256、备份旧文件）→ **重启 DSH** 生效。
- **升级（手动）**：下载新版 zip → 解压**覆盖到同一个文件夹**（保持路径不变）→ 重启 DSH。路径没变就**不用重新安装**。`,
  ],
])
