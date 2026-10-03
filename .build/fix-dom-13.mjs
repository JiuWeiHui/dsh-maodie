// 更新 dom 测试对 1.3.0 的期望：6 个标签页、气泡改成本轮口径、状态里带账户数据
import fs from 'node:fs'
import path from 'node:path'

const p = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'dom.test.mjs')
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

// 1) statusPayload 补上账户/本轮/当前模型（前端就靠这三个字段渲染）
rep(
  'W1 statusPayload 补账户数据',
  `  lastTurn: null,
  turnSeq: 0,
  native: initPayload.native,
  serverTime: Date.now(),
}`,
  `  lastTurn: null,
  turnSeq: 0,
  // 1.3.0：账户分开 + 本轮统计（金额按 token×单价估算；第三方标「仅供参考」）
  modelCtx: { provider: 'xiaomi', model: 'mimo-v2.6-pro', at: Date.now(), source: 'assistant/message' },
  turn: {
    turn: 3,
    seq: 9,
    provider: 'xiaomi',
    model: 'mimo-v2.6-pro',
    amount: 0.42,
    amountBasis: '按自定义单价估算（仅供参考）',
    tokens: 123456,
    input: 100000,
    cache: 20000,
    output: 3456,
    ts: Date.now(),
  },
  providers: {
    providers: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        displayName: 'DeepSeek',
        available: true,
        configError: '',
        balance: { known: true, total: 12.34, currency: 'CNY', source: '官方', error: '', updatedAt: Date.now(), officialTodayCost: 1.23 },
        today: { tokens: 999, estimateCost: 1.23, estimateBasis: '按官方参考价估算（官方价目）', officialCost: 1.23 },
        models: {},
        lastTurn: null,
      },
      {
        id: 'xiaomi',
        name: '小米',
        displayName: '小米 MiMo',
        available: true,
        configError: '',
        balance: { known: false, total: null, currency: 'CNY', source: '', error: '未配置官方余额来源', updatedAt: 0, officialTodayCost: null },
        today: { tokens: 222333, estimateCost: 0.56, estimateBasis: '按自定义单价估算（仅供参考）', officialCost: null },
        models: {},
        lastTurn: { amount: 0.42, amountBasis: '按自定义单价估算（仅供参考）', tokens: 123456, model: 'mimo-v2.6-pro', ts: Date.now() },
      },
    ],
    totals: { todayTokens: 223332, todayAmount: 1.79, currency: 'CNY', official: [{ id: 'deepseek-official', amount: 1.23 }], estimated: [{ id: 'xiaomi', amount: 0.56 }], note: '含 xiaomi ¥0.56（仅供参考）' },
  },
  native: initPayload.native,
  serverTime: Date.now(),
}`,
)

// 2) 气泡：标签改成「今日（本账户）」，并新增本轮/总消耗/余额未知的断言
rep(
  'W2 气泡断言',
  `  check('气泡里有今日已用', !!bubble && bubble.textContent.indexOf('今日已用') !== -1)`,
  `  check('气泡里有今日（本账户）', !!bubble && bubble.textContent.indexOf('今日（本账户）') !== -1, bubble && bubble.textContent.slice(0, 120))
  check('气泡里显示本轮金额', !!bubble && bubble.textContent.indexOf('本轮') !== -1 && bubble.textContent.indexOf('¥ 0.42') !== -1, bubble && bubble.textContent.slice(0, 160))
  check('气泡里标注本轮口径', !!bubble && bubble.textContent.indexOf('仅供参考') !== -1, bubble && bubble.textContent.slice(0, 200))
  check('气泡里显示总消耗', !!bubble && bubble.textContent.indexOf('总消耗（全部）') !== -1)
  check('没有官方余额来源时显示「余额未知」', !!bubble && bubble.textContent.indexOf('余额未知') !== -1, bubble && bubble.textContent.slice(0, 200))`,
)

// 3) 标签页：5 → 6，并加上「用量」
rep(
  'W3 标签页数量',
  `  check('有 5 个标签页', tabs.length === 5, 'count=' + tabs.length)`,
  `  check('有 6 个标签页', tabs.length === 6, 'count=' + tabs.length)`,
)
rep(
  'W4 标签页名单',
  `  check('标签页是 外观/声音/提醒/峰谷/关于', names === '外观/声音/提醒/峰谷/关于', names)`,
  `  check('标签页是 外观/声音/提醒/峰谷/用量/关于', names === '外观/声音/提醒/峰谷/用量/关于', names)`,
)

fs.writeFileSync(p, s)
console.log('dom 测试期望已更新')
