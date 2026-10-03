// 生成 GitHub Release 的 API 请求体（避免手写 JSON 转义；输出无 BOM 的 UTF-8）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NOTES = `## 安装（三种方式，任选）

1. **下载即用**（本页下方的 \`dsh-maodie-1.3.3.tgz\`）：下载并解压到固定目录，然后在 DSH 里执行
   \`plugin_manager { action: "install_bundle", target: "link:<你解压的目录>" }\`
2. **Git 直装**：\`pnpm add github:JiuWeiHui/dsh-maodie\`
3. **npm**（发布后）：\`dsh plugin add dsh-maodie\`

> **Windows 用户建议下载 zip 版**（\`dsh-maodie-1.3.3.zip\`）：右键「全部解压」即可，不用装 7-Zip；
> 解压出的文件夹直接用于上面的方式 1。命令行/CI 用 \`.tgz\`。
>
> 直链（zip）：https://github.com/JiuWeiHui/dsh-maodie/releases/download/v1.3.3/dsh-maodie-1.3.3.zip
> 直链（tgz）：https://github.com/JiuWeiHui/dsh-maodie/releases/download/v1.3.3/dsh-maodie-1.3.3.tgz
> tgz sha256：\`985d97bc0b4172bd16caf18f50a8cfce9dcd099b0852be97d18d1794ee8ef389\`

## 本版要点

- 新增：DSH 登录账号余额（充值钱包 + 赠送钱包；未登录时明确提示，不影响 API key 那条）
- 新增：每账户自定义余额来源（地址 / 凭据名 / 请求头 / 余额字段 + 「测试」按钮：回状态码、原始片段、认到的数字与候选路径）
- 新增：切换模型即时跟随（读 \`ctx.agentDefaultModel.currentSelection()\`，≤30 秒）
- 修复：通知文案支持 \`{turnCost}\` / \`{turnTokens}\`，并一次性把「本次消耗」补进已有文案
- 修复：气泡去掉所有小字（口径明细与账户清单移到 设置 → 用量）
- 测试：255 + 69 + 163 = **487 项全过**
- 致谢：计费口径借鉴 \`dsh-whale-widget\`（MIT，Copyright (c) 2026 MeteorNOX）；素材出处见 \`assets/SOURCES.md\`
`

const out = path.join(os.tmpdir(), 'gh-release-body.json')
fs.writeFileSync(
  out,
  JSON.stringify({ tag_name: 'v1.3.3', name: 'v1.3.3', body: NOTES, draft: false, prerelease: false }, null, 0),
  'utf8',
)
console.log('已生成请求体: ' + out)
console.log('说明长度: ' + NOTES.length + ' 字符')
