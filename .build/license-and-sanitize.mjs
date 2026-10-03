// 1.3.3：致谢与许可 + 本机路径脱敏
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

// 1) README：路径占位 + 致谢/许可章节
patch('README.md', [
  [
    'L1 安装示例路径占位',
    'target: "link:C:/Users/rennanchuan/Desktop/dsh-maodie" }',
    'target: "link:C:/path/to/dsh-maodie" }   # ← 换成你放插件的目录',
  ],
  [
    'L2 依赖示例路径占位',
    '"dependencies": { "maodie": "link:C:/Users/rennanchuan/Desktop/dsh-maodie" },',
    '"dependencies": { "maodie": "link:C:/path/to/dsh-maodie" },',
  ],
  [
    'L3 致谢与许可',
    '## 隐私',
    `## 致谢与许可

- 本项目以 **MIT** 许可发布（见 [LICENSE](LICENSE)）。
- **计费口径借鉴了 \`dsh-whale-widget\`（MIT，Copyright (c) 2026 MeteorNOX）的实现思路**：
  「每轮金额 = 每次模型调用的真实 usage × 该模型单价，按 (会话 id, 轮次) 分桶累加，而不是拿余额相减」——
  这个做法来自它；我们的代码是**独立编写**的（函数、结构、注释都是自己的），只借鉴了思路与价目表的组织方式。
  完整声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- 价格数字（各档单价、峰谷时段、周末谷价生效日）来自 **DeepSeek 官方定价页**，不是抄任何一个插件。

## 隐私`,
  ],
])

// 2) profile patch 注释脱敏
patch('cordis.patch.yml', [
  [
    'L4 comment 脱敏',
    'target: "link:C:/Users/rennanchuan/.dsh/local-plugins/maodie" }',
    'target: "link:<插件目录>" }',
  ],
])

// 3) dom 测试：jsdom 路径动态取（可用 MAODIE_JSDOM 覆盖）
patch('test/dom.test.mjs', [
  [
    'L5 import os',
    `import { fileURLToPath } from 'node:url'`,
    `import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'`,
  ],
  [
    'L6 jsdom 候选路径动态化',
    `let jsdom
for (const candidate of [
  path.join(__dirname, '..', 'node_modules', 'jsdom', 'lib', 'api.js'),
  'C:/Users/rennanchuan/.dsh-jsdom-tmp/node_modules/jsdom/lib/api.js',
]) {
  try {
    jsdom = await import(candidate.startsWith('C:') ? 'file:///' + candidate.replace(/\\\\/g, '/') : candidate)
    break
  } catch (err) {`,
    `let jsdom
// jsdom 可能装在仓库里，也可能装在开发机上的临时目录（可用 MAODIE_JSDOM 覆盖）
const jsdomCandidates = [
  path.join(__dirname, '..', 'node_modules', 'jsdom', 'lib', 'api.js'),
  path.join(os.homedir(), '.dsh-jsdom-tmp', 'node_modules', 'jsdom', 'lib', 'api.js'),
]
if (process.env.MAODIE_JSDOM) jsdomCandidates.unshift(process.env.MAODIE_JSDOM)
for (const candidate of jsdomCandidates) {
  try {
    jsdom = await import(pathToFileURL(candidate).href)
    break
  } catch (err) {`,
  ],
])

// 4) mount 测试：鲸鱼路径动态化
patch('test/mount.test.mjs', [
  [
    'L7 鲸鱼路径动态化',
    `  const whalePaths = [
    'C:\\\\Users\\\\rennanchuan\\\\.dsh\\\\profiles\\\\web\\\\node_modules\\\\dsh-whale-widget\\\\package.json',
  ]`,
    `  const whalePaths = [
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-whale-widget', 'package.json'),
  ]`,
  ],
])

// 5) LICENSE / THIRD-PARTY-NOTICES
const MIT = `MIT License

Copyright (c) 2026 maodie contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
fs.writeFileSync(path.join(ROOT, 'LICENSE'), MIT)
console.log('ok  写 LICENSE')

const NOTICES = `# 第三方声明（Third-Party Notices）

本项目以 MIT 许可发布。下面列出我们**借鉴过思路或数据**的第三方作品。

## dsh-whale-widget（MIT）

- 用途：**借鉴实现思路**（不是搬运代码）
- 借鉴内容：
  - 「每轮对话的金额 = 每次模型调用的真实 usage × 该模型单价，按 \`(会话 id, 轮次)\` 分桶累加」，
    从而在主会话与子代理并行时不会串账；
  - 价目表的组织方式（按模型存 \`hit/miss/out\` 三档、并区分峰谷价），以及
    「\`reasoningTokens ⊆ outputTokens\`，输出侧不重复计费」这条口径修正。
- 我们的实现是独立编写的：函数、数据结构、注释与调用流程均为自己设计。
- 许可原文（随附）：

\`\`\`
MIT License

Copyright (c) 2026 MeteorNOX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`

## DeepSeek 官方定价页（数据来源）

- 单价数字、峰谷时段（工作日 9:00-12:00、14:00-18:00，北京时间）、周末全天谷价的生效日期，
  均取自 DeepSeek 官方定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing 。
  价格属于事实数据，且会随官方调整而变化 —— **以官方页面为准**，插件里的数字只是默认参考值，
  可在设置 → 用量 的单价表里自行修改。
`
fs.writeFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), NOTICES)
console.log('ok  写 THIRD-PARTY-NOTICES.md')
