// Host patch 11 (1.3.0 第 2 步)：账户分账 + 每轮分桶结算 + 官方余额/今日已用 + 新路由
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

// ---------------------------------------------------------------- R1 账号/日账/分桶/视图
rep(
  'R1 账户与分桶核心',
  `  const usageView = () => {
    const ledger = loadLedger()`,
  `  // ---------------- 账户（供应商）维度 ----------------
  // 有官方余额来源的（DeepSeek）：余额与「今日已用」直接读官方读数；
  // 没有的（小米这类）：余额写「未知」，金额只能用自填单价估算，并且标注「仅供参考」。
  const MD_OFFICIAL_PROVIDER = 'deepseek-official'
  const mdIsOfficial = (id) => String(id || '') === MD_OFFICIAL_PROVIDER

  const mdProvider = (id, extra) => {
    const key = String(id || 'unknown')
    let p = runtime.providers[key]
    if (!p) {
      p = {
        id: key,
        name: extra && extra.name ? String(extra.name) : key,
        displayName: extra && extra.displayName ? String(extra.displayName) : '',
        available: true,
        configError: extra && extra.error ? String(extra.error) : '',
        balanceKnown: false,
        balance: null,
        currency: 'CNY',
        balanceBonus: null,
        balanceSource: '',
        balanceError: '',
        balanceUpdatedAt: 0,
        officialDayStart: null,
        officialDayStartAt: 0,
        officialTodayCost: null,
        estimateTodayCost: 0,
        todayTokens: 0,
        models: {},
        lastTurn: null,
      }
      runtime.providers[key] = p
      if (runtime.providerOrder.indexOf(key) === -1) runtime.providerOrder.push(key)
    }
    if (extra) {
      if (extra.name) p.name = String(extra.name)
      if (extra.displayName) p.displayName = String(extra.displayName)
      if (extra.error !== undefined) p.configError = String(extra.error || '')
      if (extra.available !== undefined) p.available = extra.available !== false
    }
    return p
  }

  // 供应商日账（持久化）：官方口径的日初读数 + 估算口径的累计
  const mdProviderLedger = (ledger, id) => {
    const key = String(id || 'unknown')
    if (!isPlainObject(ledger.providers)) ledger.providers = {}
    let pl = ledger.providers[key]
    if (!isPlainObject(pl)) {
      pl = { date: '', dayStart: null, dayStartAt: 0, officialTodayCost: null, estimateCost: 0, tokens: 0, models: {} }
      ledger.providers[key] = pl
    }
    if (!isPlainObject(pl.models)) pl.models = {}
    return pl
  }

  // 余额刷新后同步到账户维度：官方口径的余额 + 今日已用（今日首个读数 − 当前读数）
  const mdSyncOfficialBalance = () => {
    try {
      const p = mdProvider(MD_OFFICIAL_PROVIDER)
      const today = bjParts(Date.now()).date
      if (!runtime.balance || !isFinite(runtime.balance.totalBalance)) {
        p.balanceKnown = false
        p.balanceError = runtime.balanceError || '未读到官方余额'
        p.balanceUpdatedAt = Date.now()
        return
      }
      p.balanceKnown = true
      p.balance = runtime.balance.totalBalance
      p.currency = runtime.balance.currency || 'CNY'
      p.balanceSource = '官方余额接口 https://api.deepseek.com/user/balance'
      p.balanceError = ''
      p.balanceUpdatedAt = runtime.balance.updatedAt || Date.now()
      const ledger = loadLedger()
      const pl = mdProviderLedger(ledger, MD_OFFICIAL_PROVIDER)
      if (pl.date !== today || pl.dayStart === null) {
        pl.date = today
        pl.dayStart = runtime.balance.totalBalance
        pl.dayStartAt = Date.now()
        pl.officialTodayCost = 0
      }
      const delta = Number(pl.dayStart) - runtime.balance.totalBalance
      if (delta >= 0) {
        pl.officialTodayCost = Math.round(delta * 10000) / 10000
      } else {
        // 充值/退款：重置基准，别算成负数
        pl.dayStart = runtime.balance.totalBalance
        pl.dayStartAt = Date.now()
        pl.officialTodayCost = 0
      }
      p.officialDayStart = pl.dayStart
      p.officialDayStartAt = pl.dayStartAt
      p.officialTodayCost = pl.officialTodayCost
      saveLedger()
    } catch (err) {
      /* 忽略 */
    }
  }

  const mdTurnBuckets = () => {
    if (!runtime.turnAggs) runtime.turnAggs = new Map()
    return runtime.turnAggs
  }

  const mdAmountBasis = (provider) =>
    mdIsOfficial(provider) ? '按官方参考价估算' : '按自定义单价估算（仅供参考）'

  const mdFinalizeTurn = (sessionId) => {
    try {
      const buckets = mdTurnBuckets()
      const agg = buckets.get(sessionId)
      if (!agg) return
      buckets.delete(sessionId)
      if (!(agg.cost > 0) && !(agg.tokens > 0)) return
      runtime.lastTurnSeq = Number(runtime.lastTurnSeq || 0) + 1
      const turn = {
        turn: agg.turn,
        seq: runtime.lastTurnSeq,
        sessionId: String(sessionId || ''),
        provider: agg.provider || '',
        model: agg.model || '',
        amount: Math.round(agg.cost * 10000) / 10000,
        amountBasis: mdAmountBasis(agg.provider),
        tokens: agg.tokens,
        input: agg.input,
        cache: agg.cache,
        output: agg.output,
        byModel: agg.byModel,
        byProvider: agg.byProvider,
        startedAt: agg.startedAt,
        ts: agg.lastTs,
      }
      runtime.lastTurn = turn
      const p = mdProvider(agg.provider || 'unknown')
      p.lastTurn = { amount: turn.amount, amountBasis: turn.amountBasis, tokens: turn.tokens, model: turn.model, ts: turn.ts }
      const ledger = loadLedger()
      ledger.lastTurnSeq = runtime.lastTurnSeq
      ledger.lastTurn = turn
      saveLedger()
      runtime.turnSignal = { seq: runtime.lastTurnSeq, at: Date.now() }
    } catch (err) {
      /* 忽略 */
    }
  }

  // 每次模型调用的 usage：算钱（token × 单价）并按 (sessionId, turn) 分桶 —— 并发不串账
  const mdHandleSessionEvent = (sessionId, event) => {
    try {
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return
      if (type === 'turn/end') {
        mdFinalizeTurn(sessionId)
        return
      }
      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      if (!isFinite(turn)) return
      const src = (d.message && d.message.source) || {}
      const provider = String(src.provider || (runtime.modelCtx && runtime.modelCtx.provider) || '')
      const model = String(src.model || (runtime.modelCtx && runtime.modelCtx.model) || '')
      if (src.provider || src.model) {
        runtime.modelCtx = { provider, model, at: Date.now(), source: 'assistant/message' }
      }
      const m = mdMessageCost(d.usage, model, Date.now())
      const buckets = mdTurnBuckets()
      let agg = buckets.get(sessionId)
      if (!agg || agg.turn !== turn) {
        if (agg) mdFinalizeTurn(sessionId)
        agg = {
          turn,
          provider,
          model,
          cost: 0,
          tokens: 0,
          input: 0,
          cache: 0,
          output: 0,
          byModel: {},
          byProvider: {},
          startedAt: Date.now(),
          lastTs: Date.now(),
        }
        buckets.set(sessionId, agg)
      }
      agg.cost += m.cost
      agg.tokens += m.tokens
      agg.input += m.input
      agg.cache += m.cache
      agg.output += m.output
      if (provider) agg.provider = provider
      if (model) agg.model = model
      const mk = model || '未知'
      agg.byModel[mk] = Math.round(((agg.byModel[mk] || 0) + m.cost) * 10000) / 10000
      const pk = provider || 'unknown'
      agg.byProvider[pk] = Math.round(((agg.byProvider[pk] || 0) + m.cost) * 10000) / 10000
      agg.lastTs = Date.now()
      // 日账按供应商分开记（token 精确；金额是估算口径）
      const ledger = loadLedger()
      const pl = mdProviderLedger(ledger, pk)
      const today = bjParts(Date.now()).date
      if (pl.date !== today) {
        pl.date = today
        pl.estimateCost = 0
        pl.tokens = 0
        pl.models = {}
      }
      pl.estimateCost = (Number(pl.estimateCost) || 0) + m.cost
      pl.tokens = (Number(pl.tokens) || 0) + m.tokens
      if (model) pl.models[model] = (Number(pl.models[model]) || 0) + m.tokens
      saveLedger()
      const p = mdProvider(pk)
      p.estimateTodayCost = Math.round(pl.estimateCost * 10000) / 10000
      p.todayTokens = pl.tokens
      p.models = pl.models
    } catch (err) {
      /* 观察者失败不影响会话 */
    }
  }

  // 启动时把 DSH 认识的供应商登记进来（可用路由 + 已声明但没配通的）
  const mdRegisterProviders = () => {
    try {
      const llm = ctx.get('llm')
      if (!llm || typeof llm.listProviders !== 'function') return
      const list = llm.listProviders() || []
      for (const it of list) {
        if (!it) continue
        mdProvider(it.id || it.name, { name: it.name || it.id, available: true })
      }
      if (typeof llm.listConfigurableProviders === 'function') {
        const declared = llm.listConfigurableProviders() || []
        for (const it of declared) {
          if (!it) continue
          mdProvider(it.provider, {
            name: it.displayName || it.provider,
            displayName: it.displayName || '',
            error: it.error || '',
            available: !it.error,
          })
        }
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  const mdProvidersView = () => {
    const out = []
    for (const id of runtime.providerOrder) {
      const p = runtime.providers[id]
      if (!p) continue
      out.push({
        id: p.id,
        name: p.name || p.id,
        displayName: p.displayName || '',
        available: p.available !== false,
        configError: p.configError || '',
        balance: {
          known: p.balanceKnown === true,
          total: p.balanceKnown ? p.balance : null,
          currency: p.currency || 'CNY',
          bonus: p.balanceBonus,
          source: p.balanceSource || '',
          error: p.balanceError || '',
          updatedAt: p.balanceUpdatedAt || 0,
          officialTodayCost: mdIsOfficial(p.id) ? p.officialTodayCost : null,
          dayStart: mdIsOfficial(p.id) ? p.officialDayStart : null,
        },
        today: {
          tokens: Number(p.todayTokens) || 0,
          estimateCost: Math.round((Number(p.estimateTodayCost) || 0) * 10000) / 10000,
          estimateBasis: mdAmountBasis(p.id),
          officialCost: mdIsOfficial(p.id) ? p.officialTodayCost : null,
        },
        models: p.models || {},
        lastTurn: p.lastTurn || null,
      })
    }
    // 总额：金额只把「有官方口径」的和「有单价可估」的都算进来，但分开标注
    let tokens = 0
    let amount = 0
    const official = []
    const estimated = []
    for (const p of out) {
      tokens += p.today.tokens || 0
      if (p.today.officialCost !== null && p.today.officialCost !== undefined) {
        amount += Number(p.today.officialCost) || 0
        official.push({ id: p.id, amount: Math.round((Number(p.today.officialCost) || 0) * 10000) / 10000 })
      } else {
        amount += Number(p.today.estimateCost) || 0
        estimated.push({ id: p.id, amount: p.today.estimateCost })
      }
    }
    return {
      providers: out,
      totals: {
        todayTokens: tokens,
        todayAmount: Math.round(amount * 10000) / 10000,
        currency: 'CNY',
        official,
        estimated,
        note: estimated.length
          ? '含 ' + estimated.map((x) => x.id + ' ¥' + x.amount).join('、') + '（仅供参考）'
          : '全部来自官方口径',
      },
    }
  }

  const mdUsageView = () => {
    const ledger = loadLedger()
    const view = mdProvidersView()
    return {
      current: {
        provider: (runtime.modelCtx && runtime.modelCtx.provider) || '',
        model: (runtime.modelCtx && runtime.modelCtx.model) || '',
        at: (runtime.modelCtx && runtime.modelCtx.at) || 0,
        source: (runtime.modelCtx && runtime.modelCtx.source) || '',
      },
      turn: runtime.lastTurn || null,
      turnSeq: Number(runtime.lastTurnSeq) || 0,
      today: view.totals,
      providers: view.providers,
      pricing: {
        source: MD_PRICE_SOURCE,
        note: '官方参考价（元/百万 token，含峰谷），可在设置里给第三方模型填自定义单价',
        peakHours: '工作日 9:00-12:00、14:00-18:00（北京时间）；周末全天谷价',
        builtin: MD_BUILTIN_PRICES,
        custom: (state.pricing && state.pricing.custom) || {},
      },
      date: ledger.date || '',
    }
  }

  const usageView = () => {
    const ledger = loadLedger()`,
)

// ---------------------------------------------------------------- R2 fetchBalance 包装：同步账户维度
rep('R2 rename legacy balance', `  const fetchBalance = async () => {`, `  const mdFetchBalanceLegacy = async () => {`)
rep(
  'R2b wrapper',
  `    try {
      return await runtime.balanceInFlight
    } finally {
      runtime.balanceInFlight = null
    }
  }
`,
  `    try {
      return await runtime.balanceInFlight
    } finally {
      runtime.balanceInFlight = null
      try {
        mdSyncOfficialBalance()
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  // 对外仍是 fetchBalance：读官方余额 + 同步到账户维度（余额 / 今日已用都走官方读数）
  const fetchBalance = async () => mdFetchBalanceLegacy()
`,
)

// ---------------------------------------------------------------- R3 start(): 桶 + 供应商登记 + seq 恢复
rep(
  'R3 start init',
  `    runtime.bootId = 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)`,
  `    runtime.bootId = 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    runtime.turnAggs = new Map()
    try {
      const l = loadLedger()
      runtime.lastTurnSeq = Number(l.lastTurnSeq) || 0
      runtime.lastTurn = l.lastTurn || null
    } catch (err) {
      /* 忽略 */
    }
    mdRegisterProviders()`,
)

// ---------------------------------------------------------------- R4 会话事件接进分桶
rep(
  'R4 事件接分桶',
  `            accumulateUsage(data.usage, model)
            accumulateSession(data.usage, sessId)
            return
          }
          if (ev.type === 'turn/end') {
            fireTurnEnd(sessId)
          }`,
  `            accumulateUsage(data.usage, model)
            accumulateSession(data.usage, sessId)
            mdHandleSessionEvent(sessId, ev)
            return
          }
          if (ev.type === 'turn/end') {
            mdHandleSessionEvent(sessId, ev)
            fireTurnEnd(sessId)
          }`,
)

// ---------------------------------------------------------------- R5 新路由
rep(
  'R5 providers/usage 路由',
  `    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——`,
  `    // —— 路由：账户与用量（余额/今日已用按官方口径，第三方金额标注仅供参考）——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/providers.json',
      handler: (req, res) => {
        const view = mdProvidersView()
        sendJson(res, 200, Object.assign({ ok: true, at: Date.now(), current: runtime.modelCtx || null }, view))
      },
    })
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/usage.json',
      handler: (req, res) => {
        sendJson(res, 200, Object.assign({ ok: true, at: Date.now() }, mdUsageView()))
      },
    })

    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——`,
)

// ---------------------------------------------------------------- R6 status / diag 暴露
rep(
  'R6 status providers',
  `          alarms: alarmSchedule(),
          native: runtime.native,`,
  `          alarms: alarmSchedule(),
          providers: mdProvidersView(),
          turn: runtime.lastTurn,
          modelCtx: runtime.modelCtx,
          native: runtime.native,`,
)
rep(
  'R6b diag providers',
  `          alarms: alarmSchedule(),
          alarmChecks: runtime.lastAlarmCheck,`,
  `          alarms: alarmSchedule(),
          alarmChecks: runtime.lastAlarmCheck,
          providers: mdProvidersView(),
          usage: mdUsageView(),`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
