// Host patch 12 (1.3.0 第 3 步)：金额口径标注精确化 + 单价来源透出
//   * 官方供应商：按官方参考价估算
//   * 第三方填了自定义单价：按自定义单价估算（仅供参考）
//   * 第三方没填：按内置参考价估算（仅供参考）—— 明确说出用的是哪份价，而不是假装官方
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'index.js')

let s = fs.readFileSync(TARGET, 'utf8')
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

rep(
  'S1 记账带上单价来源',
  `  const mdAmountBasis = (provider) =>
    mdIsOfficial(provider) ? '按官方参考价估算' : '按自定义单价估算（仅供参考）'`,
  `  const mdAmountBasis = (provider, priceBasis) => {
    if (mdIsOfficial(provider)) return '按官方参考价估算（官方价目）'
    const custom = String(priceBasis || '').indexOf('自定义') !== -1
    return custom ? '按自定义单价估算（仅供参考）' : '按内置参考价估算（仅供参考）'
  }`,
)

rep(
  'S2 turn 里记录 priceBasis',
  `        amount: Math.round(agg.cost * 10000) / 10000,
        amountBasis: mdAmountBasis(agg.provider),`,
  `        amount: Math.round(agg.cost * 10000) / 10000,
        amountBasis: mdAmountBasis(agg.provider, agg.priceBasis),`,
)

rep(
  'S3 桶里带上 priceBasis',
  `          byModel: {},
          byProvider: {},
          startedAt: Date.now(),
          lastTs: Date.now(),
        }
        buckets.set(sessionId, agg)
      }`,
  `          byModel: {},
          byProvider: {},
          priceBasis: '',
          startedAt: Date.now(),
          lastTs: Date.now(),
        }
        buckets.set(sessionId, agg)
      }
      if (m.priceBasis) agg.priceBasis = m.priceBasis`,
)

rep(
  'S4 provider.lastTurn 口径',
  `      p.lastTurn = { amount: turn.amount, amountBasis: turn.amountBasis, tokens: turn.tokens, model: turn.model, ts: turn.ts }`,
  `      p.lastTurn = { amount: turn.amount, amountBasis: turn.amountBasis, tokens: turn.tokens, model: turn.model, ts: turn.ts }
      p.estimateTodayCost = Math.round((Number(p.estimateTodayCost) || 0) * 10000) / 10000`,
)

rep(
  'S5 今日估算口径也带来源',
  `        today: {
          tokens: Number(p.todayTokens) || 0,
          estimateCost: Math.round((Number(p.estimateTodayCost) || 0) * 10000) / 10000,
          estimateBasis: mdAmountBasis(p.id),
          officialCost: mdIsOfficial(p.id) ? p.officialTodayCost : null,
        },`,
  `        today: {
          tokens: Number(p.todayTokens) || 0,
          estimateCost: Math.round((Number(p.estimateTodayCost) || 0) * 10000) / 10000,
          estimateBasis: mdAmountBasis(p.id, p.lastTurn && p.lastTurn.priceBasis),
          officialCost: mdIsOfficial(p.id) ? p.officialTodayCost : null,
        },`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
