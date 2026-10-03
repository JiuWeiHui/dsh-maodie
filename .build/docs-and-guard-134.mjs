// 1.3.4 文档（用宽松锚点，避免再卡住）+ 给 [26] 加"绝不写进仓库目录"的保险
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

function swap(rel, edits) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  const eol = s.includes('\r\n') ? '\r\n' : '\n'
  s = s.split('\r\n').join('\n')
  for (const [name, from, to] of edits) {
    const n = s.split(from).length - 1
    if (n === 0) {
      console.log('  ⚠ ' + rel + ' :: ' + name + ' — 没找到，跳过')
      continue
    }
    s = s.split(from).join(to)
    console.log('  ✓ ' + rel + ' :: ' + name + ' ×' + n)
  }
  fs.writeFileSync(p, s.split('\n').join(eol))
}

console.log('=== README 计数与新增小节 ===')
swap('README.md', [
  ['路由计数', '逐条请求 23 组路由', '逐条请求 26 组路由'],
  ['挂载计数', '**255 项通过 / 0 失败**', '**282 项通过 / 0 失败**'],
  ['契约计数', '**69 项通过 / 0 失败**', '**71 项通过 / 0 失败**'],
  ['前端计数', '**163 项通过，0 页面异常**', '**178 项通过，0 页面异常**'],
  [
    '检查更新小节',
    '## 仓库与版本',
    `### 检查更新与自动更新（1.3.4）

设置 → **关于** 里有更新面板：

| 能力 | 说明 |
| --- | --- |
| **检查更新** | 读 GitHub Releases（\`api.github.com/repos/JiuWeiHui/dsh-maodie/releases/latest\`，**国内可直连、不需要代理**），和本地版本做 semver 比较 |
| **何时检查** | 启动后查一次 + 每 6 小时一次；也可以随时点「检查更新」；自动检查可在面板里关掉 |
| **一键更新** | 点「立即更新」→ 先**预演**（列出将要覆盖的文件让你确认）→ 下载 \`.tgz\` → **校验官方 sha256** → 解包 → **只覆盖运行必需文件**（\`lib/\`、\`assets/\`、\`cordis.patch.yml\`、README/LICENSE/NOTICES/package.json），**保留** \`.git\`、\`.build\`、\`test\` → 旧文件备份到 \`.update-backup-<旧版本>/\` → 提示「重启 DSH 生效」 |
| **自动安装** | 默认**关**。开启后检查到新版本会直接装（仍需重启 DSH）；面板会提示当前目录是不是 git 工作区 |
| **安全阀** | ① 下载内容 sha256 与官方不一致 → **中止且不动任何文件** ② 目标目录 \`package.json\` 名字不是 \`dsh-maodie\` → 拒绝 ③ 包里的 \`../\` 路径穿越被拒 ④ 预演模式只报告不写入 |

> 回退办法：把 \`.update-backup-<版本>/\` 里的文件拷回去，或 \`git checkout .\`（如果你用 git 管理这份目录）。

## 仓库与版本`,
  ],
])

console.log('=== INSTALL 补应用内更新 ===')
swap('INSTALL.md', [
  [
    '升级方式',
    '- **升级**：下载新版 zip → 解压**覆盖到同一个文件夹**（保持路径不变）→ 重启 DSH。路径没变就**不用重新安装**。',
    `- **升级（推荐）**：右键猫 → 设置 → **关于** → 「检查更新」→ 有新版本时点「立即更新」（会先列出要覆盖的文件让你确认，然后校验官方 sha256、备份旧文件）→ **重启 DSH** 生效。
- **升级（手动）**：下载新版 zip → 解压**覆盖到同一个文件夹**（保持路径不变）→ 重启 DSH。路径没变就**不用重新安装**。`,
  ],
])

console.log('=== [26] 加保险：更新目标固定为临时目录 + 断言仓库 README 未被改写 ===')
swap('test/mount.test.mjs', [
  [
    '保险目标目录',
    `console.log('\\n[26] 检查更新 + 一键更新（预演 / 校验 / 白名单 / 真实写入）')
{`,
    `console.log('\\n[26] 检查更新 + 一键更新（预演 / 校验 / 白名单 / 真实写入）')
{
  // 铁律：这套用例绝不允许写进仓库目录。先把更新目标指到临时目录，
  // 之后再按用例覆盖；下面还有一条断言专门检查仓库 README 没被动过。
  const safeTarget = path.join(tmp, 'update-safe-target')
  fs.mkdirSync(safeTarget, { recursive: true })
  fs.writeFileSync(path.join(safeTarget, 'package.json'), JSON.stringify({ name: 'dsh-maodie', version: '0.0.1' }))
  process.env.MAODIE_UPDATE_TARGET = safeTarget`,
  ],
  [
    '断言仓库 README 未被改写',
    `  check('目标目录不对时拒绝更新', refused.ok === false && String(refused.error).indexOf('不像本插件') !== -1, JSON.stringify(refused.error))`,
    `  check('目标目录不对时拒绝更新', refused.ok === false && String(refused.error).indexOf('不像本插件') !== -1, JSON.stringify(refused.error))

  // 铁律复查：整个 [26] 跑完，仓库里的 README 与 cordis.patch.yml 必须一个字节没变
  const repoReadme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  const repoPatch = fs.readFileSync(path.join(__dirname, '..', 'cordis.patch.yml'), 'utf8')
  check('测试没有改写仓库 README', repoReadme.indexOf('fake readme') === -1 && repoReadme.length > 1000, String(repoReadme.length))
  check('测试没有改写仓库 cordis.patch.yml', repoPatch.indexOf('dsh-maodie') !== -1 && repoPatch.indexOf('- insert: []') === -1, repoPatch.slice(0, 60).replace(/\\n/g, ' '))`,
  ],
])
