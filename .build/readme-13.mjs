// README 更新到 1.3.0：测试计数 + 「用量与计费」章节 + 这次踩的两个命名坑
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), 'README.md')
let s = fs.readFileSync(p, 'utf8')
let hits = 0
function rep(name, from, to, expect = 1) {
  const n = s.split(from).length - 1
  if (n !== expect) {
    console.error('MISMATCH [' + name + '] found=' + n + ' expected=' + expect)
    process.exit(1)
  }
  s = s.split(from).join(to)
  hits++
  console.log('ok  ' + name)
}

rep('计数：路由', '| 路由与业务逻辑 | 假 Cordis Context 挂载，逐条请求 20 组路由 | **214 项通过 / 0 失败** |', '| 路由与业务逻辑 | 假 Cordis Context 挂载，逐条请求 22 组路由 | **229 项通过 / 0 失败** |')
rep('计数：前端', '**139 项通过，0 页面异常**', '**152 项通过，0 页面异常**')

rep(
  '新增「用量与计费」章节',
  `## 仓库与版本`,
  `## 用量与计费（1.3.0）

### 三个概念，别混

| 概念 | 口径 | 说明 |
| --- | --- | --- |
| **账户余额** | 官方读数 | DeepSeek 走官方余额接口；没有官方来源的账户（如小米）显示「**余额未知**」，绝不拿别家数字顶 |
| **今日已用（账户级）** | 官方读数差 | 今日首个官方读数 − 当前官方读数；充值/退款会自动重置基准。这就是"这个账号今天到底扣了多少"，不需要自己算 |
| **本轮金额（对话级）** | token × 单价 | 一次指令 → 一次完成，按 \`(会话, 轮次)\` 分桶累加，**主会话与子代理/多会话并行都不串账** |

### 每轮金额是怎么算的（为什么不靠近两次余额相减）

并发的时侯「两次读数相减」根本分不出是谁花的钱，所以金额来自**每次模型调用的真实 usage**：

- DSH 每次调用都给 \`usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}\` 与 \`source{provider, model}\`；
- 金额 = \`缓存命中/1e6×命中价 + 未命中输入/1e6×输入价 + 输出/1e6×输出价\`（\`reasoning ⊆ output\`，输出侧不重复计费）；
- 单价含**峰谷**：工作日 9:00-12:00、14:00-18:00（北京时间）为峰价，**周末全天谷价**；价目来源是 DeepSeek 官方定价页，口径与同机另一个计费插件保持一致；
- 桶的键是 **(会话 id, 轮次)**，\`turn/end\` 时结算成"本轮"，落盘 seq 便于前端分辨新旧轮次。

### 金额口径的标注（诚实第一）

| 情形 | 显示 |
| --- | --- |
| DeepSeek 官方 | \`按官方参考价估算（官方价目）\` |
| 第三方 + 你填了自定义单价 | \`按自定义单价估算（仅供参考）\` |
| 第三方 + 没填单价 | \`按内置参考价估算（仅供参考）\` |
| 账户级今日已用（DeepSeek） | \`官方读数差\` |

**总消耗**（所有账户加总）会单独标出估算部分，形如 \`含 xiaomi ¥0.56（仅供参考）\`。

### 单价表怎么填

设置 → **用量** → 「单价表（元/百万 token）」：填**模型名关键词**（子串匹配，长的优先，例如 \`mimo\`）+ 命中/未命中/输出三个价，可选币种（USD 时再填汇率）。
DeepSeek 内置官方参考价，不用填；第三方（小米 MiMo 等）填一次即可，之后它的金额才有数。

### 接口与字段

| 路由 / 字段 | 内容 |
| --- | --- |
| \`GET /maodie/providers.json\` | 每个账户的余额（\`known/total/source/error\`）、今日（\`officialCost\` 或 \`estimateCost\`）、本轮、模型明细；外加 \`totals\`（含 \`official[]\`/\`estimated[]\`/\`note\`） |
| \`GET /maodie/turn.json\` | 当前供应商/模型 + 本轮快照 + 价目（内置与自定义） |
| \`status.json\` | 增加 \`providers\` / \`turn\` / \`modelCtx\`（气泡与「用量」页就用这三个） |
| \`diag\` | 增加 \`providers\` / \`usage\`，排查时一次看全 |
| ⚠️ | 原有的 \`/maodie/usage.json\`（日记账）保持不动，新接口叫 **turn.json**，别搞混 |

### 这次踩的两个命名坑（都是"原插件早就有"）

1. **路由撞名**：我一开始把新接口叫 \`/maodie/usage.json\`，可原插件**已经**用它当日记账本路由了 —— 后注册的会被先注册的吃掉，测试里正好抓到，才改名 \`turn.json\`。
2. **字段撞名**：我用 \`runtime.lastTurn\` 存本轮统计，可原插件**已经**用这个名字存"上一次投递负载"了 —— 读出来的东西完全不是我的，改成 \`runtime.lastTurnUsage\`。

教训：在这类"长期演进的插件"里加字段/路由前，**先在原文件里搜一遍名字**，别指望命名空间是空的。

## 仓库与版本`,
)

fs.writeFileSync(p, s)
console.log('README 更新完成，共 ' + hits + ' 处')
