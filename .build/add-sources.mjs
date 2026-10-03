// 补 assets/SOURCES.md（素材出处）+ README 指个路
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

const SOURCES = `# 素材出处

本仓库 \`assets/\` 下的形象图与音效**不是原创作品**，来源如下（均为 B 站视频）。
**版权归各原作者所有**，本项目仅作个人使用/学习用途收录。
如原作者不希望被收录，告知即删。

| 仓库里的文件 | 用途 | 出处 |
| --- | --- | --- |
| \`cat-idle.png\`、\`cat-hiss.png\` | 猫的「常态 / 哈气」两张形象图 | 【圆头耄耋原视频】https://www.bilibili.com/video/BV1fsu3zME3R/ |
| \`sound/qichuang.mp3\` | 内置音效「起床哈」（1 分 30 秒） | 【哈基米音乐：起床哈】https://www.bilibili.com/video/BV1FnmzBFELR/ |
| \`sound/dahuoji.mp3\` | 内置音效「打火基」（2 分 03 秒） | 【《打火基》完整版】https://www.bilibili.com/video/BV1AestzcE91/ |
| \`sound/jiao.mp3\` | 内置音效「叫一叫」（55 秒） | 【⚡️来个耄耋叫一叫⚡️～】https://www.bilibili.com/video/BV1Y9Ni66EJA/ |
| \`sound/lanlian.mp3\` | 内置音效「蓝莲哈」（4 分 33 秒） | 【【哈基米音乐】蓝莲哈完整版（Hi-Res 无损音质）】https://www.bilibili.com/video/BV135pmzZE4K/ |
| \`sound/hiss.m4a\` | 内置音效「哈气」（1 秒） | 出处待补（推测同样来自「圆头耄耋原视频」） |

> 说明：素材只影响插件**自带的默认形象与默认音效**，不影响功能。
> 你完全可以换成自己的：
>
> - 设置 → **外观**：上传自定义形象图（常态 / 哈气各一张）
> - 设置 → **声音**：上传自己的音效素材，或在素材库里挑选
>
> 若要在**公开分发**时规避素材版权风险，把 \`assets/\` 下的图片与音效替换成自有的，
> 或从仓库移除（\`git rm --cached assets/*.png assets/sound/*\`）并让使用者自行准备。
`
fs.writeFileSync(path.join(ROOT, 'assets', 'SOURCES.md'), SOURCES)
console.log('ok  写 assets/SOURCES.md')

const rp = path.join(ROOT, 'README.md')
let s = fs.readFileSync(rp, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')
const from = `- 价格数字（各档单价、峰谷时段、周末谷价生效日）来自 **DeepSeek 官方定价页**，不是抄任何一个插件。`
const to = `- 价格数字（各档单价、峰谷时段、周末谷价生效日）来自 **DeepSeek 官方定价页**，不是抄任何一个插件。
- \`assets/\` 下的形象图与音效**非原创**，来自 B 站若干视频，逐项出处见 [assets/SOURCES.md](assets/SOURCES.md)（版权归原作者，可自行替换）。`
if (s.indexOf(from) === -1) {
  console.error('README 锚点没找到')
  process.exit(1)
}
s = s.split(from).join(to)
fs.writeFileSync(rp, s.split('\n').join(eol))
console.log('ok  README 指向 assets/SOURCES.md')
