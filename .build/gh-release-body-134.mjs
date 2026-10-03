// 生成 v1.3.4 Release 的 API 请求体（无 BOM UTF-8）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NOTES = `## 安装（三种方式，任选）

1. **下载即用**（本页下方的 \`dsh-maodie-1.3.4.zip\`，Windows 右键「全部解压」）：解压到固定目录，然后在 DSH 里执行
   \`plugin_manager { action: "install_bundle", target: "link:<你解压的目录>" }\`
2. **Git 直装**：\`pnpm add github:JiuWeiHui/dsh-maodie\`
3. **npm**（发布后）：\`dsh plugin add dsh-maodie\`

> 直链（zip）：https://github.com/JiuWeiHui/dsh-maodie/releases/download/v1.3.4/dsh-maodie-1.3.4.zip
> 直链（tgz）：https://github.com/JiuWeiHui/dsh-maodie/releases/download/v1.3.4/dsh-maodie-1.3.4.tgz
> tgz sha256：\`d40629d8dbb56304b0166e007621d08d364592824050fb3a6287a37283fa5a13\`
> zip sha256：\`7d60122b96c984fdf5c1840f14c9cfa942cf91b9138d014f3b4be2a3d9ff85bb\`

**已经在用 1.3.4 及以后版本的，可以在 设置 → 关于 里点「立即更新」自动升级**（会先列出要覆盖的文件、校验官方 sha256、备份旧文件）。

## 本版要点

### 新增：检查更新 + 一键更新

- **检查更新**：读 GitHub Releases（\`api.github.com\`，国内可直连）与本地版本做 semver 比较；启动后查一次 + 每 6 小时一次，也可手动点；自动检查可关。
- **一键更新**：设置 → 关于 → 「立即更新」→ 先**预演**（列出将要覆盖的文件让你确认）→ 下载 \`.tgz\` → **校验官方 sha256** → 解包 → **只覆盖运行必需文件**（\`lib/\`、\`assets/\`、\`cordis.patch.yml\`、README/LICENSE/NOTICES/package.json），**保留** \`.git\`、\`.build\`、\`test\` → 旧文件备份到 \`.update-backup-<旧版本>/\` → 提示「重启 DSH 生效」。
- **安全阀**：sha256 不一致 → 中止且不动任何文件；目标目录 \`package.json\` 名字不符 → 拒绝；包内 \`../\` 路径穿越被拒；预演模式只报告不写入。

### 修复

- 测试用例之一曾在真实目录执行过一次更新写入，把仓库的 \`README.md\`、\`cordis.patch.yml\` 覆盖成假包内容 —— 已恢复，并加了三道保险（测试强制写入临时目录 + 断言仓库文件跑完未被改写 + \`.gitignore\` 忽略备份目录）。

### 测试

**284 + 71 + 178 = 533 项全过**（挂载 / 契约 / jsdom 真跑前端）。

## 致谢

- 计费口径借鉴 \`dsh-whale-widget\`（MIT，Copyright (c) 2026 MeteorNOX）；素材出处见 \`assets/SOURCES.md\`。
`

const out = path.join(os.tmpdir(), 'gh-release-body-134.json')
fs.writeFileSync(
  out,
  JSON.stringify({ tag_name: 'v1.3.4', name: 'v1.3.4', body: NOTES, draft: false, prerelease: false }, null, 0),
  'utf8',
)
console.log('已生成: ' + out + '（说明 ' + NOTES.length + ' 字）')
