// README 更新到 1.3.2：计数 + 余额来源（账号 / 自定义 / 切换跟随）
import fs from 'node:fs'
import path from 'node:path'
const p = path.join(path.resolve(import.meta.dirname, '..'), 'README.md')
let s = fs.readFileSync(p, 'utf8')
function rep(name, from, to, expect = 1) {
  const n = s.split(from).length - 1
  if (n !== expect) {
    console.error('MISMATCH [' + name + '] found=' + n + ' expected=' + expect)
    process.exit(1)
  }
  s = s.split(from).join(to)
  console.log('ok  ' + name)
}

rep('计数：路由', '逐条请求 22 组路由 | **231 项通过 / 0 失败**', '逐条请求 23 组路由 | **255 项通过 / 0 失败**')
rep('计数：契约', '**68 项通过 / 0 失败**', '**69 项通过 / 0 失败**')
rep('计数：前端', '**156 项通过，0 页面异常**', '**163 项通过，0 页面异常**')

rep(
  '新增「余额来源」小节',
  `## 仓库与版本`,
  `### 余额来源（1.3.2）

三条路，互不冒充，各自标注来源：

| 来源 | 谁 | 怎么读 | 要配置吗 |
| --- | --- | --- | --- |
| **官方 API key** | \`deepseek-official\`（你自己配的 key） | 内置 \`https://api.deepseek.com/user/balance\` + 凭据 \`DEEPSEEK_API_KEY\` | **不用**（插件内置） |
| **DSH 登录账号** | \`DeepSeek Account\` | \`ctx.get('deepseekAccount')\` → \`getBalance()\` 给**充值钱包 + 赠送钱包**；\`getState().links.usageUrl\` 给官方用量页 | **不用**（登录就有；未登录时明确写「未登录」，不影响上面那条） |
| **自定义接口** | 小米等其它供应商 | 你在「用量」页填：地址 + 凭据名 + 请求头 + 余额字段 + 币种字段 | **要填**（没有就显示「余额未知」） |

**自定义来源怎么填**（设置 → 用量 → 每个账户卡片下面）：

- **地址**：能返回 JSON、且里面含余额数字的那个接口（例如 \`https://<网关>/user/balance\`、\`https://<网关>/dashboard/billing/credit_grants\`、控制台的 \`/api/v1/account/balance\`）
- **凭据**：环境变量/凭据名（没有就留空）
- **请求头**：默认 \`Authorization\`（自动加 \`Bearer \` 前缀）；**小米这类控制台接口用 \`Cookie\`**，把请求头改成 \`Cookie\`、前缀留空
- **余额字段**：JSON 路径，如 \`data.balance\`、\`balance_infos.0.total_balance\`；**不确定就点「测试」** —— 会回 HTTP 状态、是否 JSON、**认到的数字与字段**，以及返回里所有候选数字（帮你挑字段）。写错/不写时插件会**自动挑**并在结果里标注「自动挑的」，不会静默瞎填
- 失败一律如实写进卡片（\`HTTP 401\`、\`返回不是 JSON\`、\`找不到余额数字（字段路径：…）\`）

**切换模型如何跟随**：每次 \`/status.json\` 轮询都会读一次 \`ctx.agentDefaultModel.currentSelection()\` —— 你在模型列表里一换，**最多 30 秒**气泡与「用量」页就换成那家的余额与消耗（不必等下一轮对话；真跑过一轮后则以真实调用的 \`source\` 为准）。账号余额与自定义来源每 **60 秒**刷一次，页面上也有「账号余额 / 自定义来源 / 官方余额」三个手动刷新按钮。

> 说明：账号那条用的是**定时轮询**（60 秒）而不是 \`watch()\` 订阅 —— 行为一致、实现更简单；哪天需要秒级实时再换订阅。

## 仓库与版本`,
)

fs.writeFileSync(p, s)
console.log('README 更新完成')
