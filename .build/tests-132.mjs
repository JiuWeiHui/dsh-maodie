// 1.3.2 第 2-3 步的回归：自定义余额来源（含试接口）+ 切换模型即时跟随
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

const p = path.join(ROOT, 'test', 'mount.test.mjs')
let s = fs.readFileSync(p, 'utf8')
const eol = s.includes('\r\n') ? '\r\n' : '\n'
s = s.split('\r\n').join('\n')
function rep(name, from, to, expect = 1) {
  const n = s.split(from).length - 1
  if (n !== expect) {
    console.error('MISMATCH [' + name + '] found=' + n + ' expected=' + expect)
    process.exit(1)
  }
  s = s.split(from).join(to)
  console.log('ok  ' + name)
}

// 1) fetch 打桩：加一个自定义余额接口（要带 text()，自定义来源走 text）
rep(
  'AD1 打桩自定义余额接口',
  `  if (u.includes('/api/holiday/year/')) {`,
  `  if (u.includes('example.test/balance')) {
    const body = JSON.stringify({ data: { balance: 7.5, currency: 'USD', note: 'ok' } })
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
  }
  if (u.includes('/api/holiday/year/')) {`,
)

// 2) 假 ctx：agentDefaultModel（切换模型即时跟随用）
rep(
  'AD2 假 ctx 支持 agentDefaultModel',
  `    if (name === 'deepseekAccount') {`,
  `    if (name === 'agentDefaultModel') {
      if (!defaultModelSelection) return undefined
      return {
        currentSelection() {
          return defaultModelSelection
        },
      }
    }
    if (name === 'deepseekAccount') {`,
)
rep(
  'AD3 开关变量',
  `let accountService = false
let accountSignedIn = false`,
  `let accountService = false
let accountSignedIn = false
let defaultModelSelection = null`,
)

// 3) 新增 [25]
rep(
  'AD4 新增 [25]',
  `// ---------------------------------------------------------------- 收尾
globalThis.fetch = realFetch`,
  `console.log('\\n[25] 自定义余额来源（含试接口）+ 切换模型即时跟随')
{
  // 1) 试接口：只读地请求一次，回状态码 + 原始片段 + 挑出的数字与候选路径（不改配置）
  const test = (
    await callRoute('/maodie/balance-test.json', 'POST', {
      url: 'https://example.test/balance',
      fieldPath: 'data.balance',
      currencyPath: 'data.currency',
    })
  ).json()
  check('试接口拿到 HTTP 状态', test.ok === true && test.status === 200, JSON.stringify(test).slice(0, 160))
  check(
    '试接口认出余额与字段路径',
    !!test.picked && test.picked.value === 7.5 && test.picked.path === 'data.balance',
    JSON.stringify(test.picked),
  )
  check('试接口给出候选数字（方便从返回里挑）', Array.isArray(test.candidates) && test.candidates.length > 0, JSON.stringify(test.candidates))
  check('试接口回币种', String(test.currency) === 'USD', String(test.currency))
  check('试接口带原始返回片段', typeof test.bodySnippet === 'string' && test.bodySnippet.length > 0)

  // 2) 配上自定义来源 → 刷新 → 该账户余额变成自定义接口的数
  await callRoute('/maodie/state.json', 'POST', {
    state: {
      balances: {
        custom: {
          xiaomi: { url: 'https://example.test/balance', fieldPath: 'data.balance', currencyPath: 'data.currency' },
        },
      },
    },
  })
  await callRoute('/maodie/diag?refreshBalances=1')
  const provs = (await callRoute('/maodie/providers.json')).json()
  const xm = provs.providers.find((p) => p.id === 'xiaomi')
  check('自定义来源生效：余额被填上', !!xm && xm.balance.known === true && xm.balance.total === 7.5, JSON.stringify(xm && xm.balance))
  check('自定义来源：币种按字段解析', !!xm && xm.balance.currency === 'USD', JSON.stringify(xm && xm.balance))
  check('自定义来源：来源标注到域名', !!xm && String(xm.balance.source).indexOf('example.test') !== -1, xm && xm.balance.source)

  // 3) 没配来源、又没自动挑到字段时，明确报错而不是瞎填
  await callRoute('/maodie/state.json', 'POST', {
    state: { balances: { custom: { 'no-such': { url: 'https://example.test/balance', fieldPath: 'nope.deep' } } } },
  })
  await callRoute('/maodie/diag?refreshBalances=1')
  const provs2 = (await callRoute('/maodie/providers.json')).json()
  const ns = provs2.providers.find((p) => p.id === 'no-such')
  check('字段路径不对时如实报错（不瞎填数字）', !!ns && ns.balance.known === false && String(ns.balance.error).length > 0, JSON.stringify(ns && ns.balance))
  check('错误里说清字段路径', !!ns && String(ns.balance.error).indexOf('字段路径') !== -1, ns && ns.balance.error)

  // 4) 切换模型即时跟随：读 ctx.agentDefaultModel.currentSelection()
  defaultModelSelection = { provider: 'xiaomi', model: 'mimo-v2.6-pro' }
  const st = (await callRoute('/maodie/status.json')).json()
  check('状态里跟随默认模型选择', !!st.modelCtx && st.modelCtx.provider === 'xiaomi' && st.modelCtx.model === 'mimo-v2.6-pro', JSON.stringify(st.modelCtx))
  check('并标明来源是默认选择', !!st.modelCtx && st.modelCtx.source === 'default-selection', String(st.modelCtx && st.modelCtx.source))
  defaultModelSelection = null
}

// ---------------------------------------------------------------- 收尾
globalThis.fetch = realFetch`,
)

fs.writeFileSync(p, s.split('\n').join(eol))
console.log('written test/mount.test.mjs')
