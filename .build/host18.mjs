// Host patch 17 (1.3.2 第 2-3 步)：
//   ② 每账户可自定义余额来源：URL + 凭据名 + 请求头 + 余额字段路径 + 币种字段
//      —— 带 GET/POST /maodie/balance-test.json 试接口（返回状态码、原始片段、自动挑出的数字与候选路径）
//   ③ 切换模型即时跟随：读 ctx.agentDefaultModel.currentSelection()，状态轮询里就能看到新供应商
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
  'AC1 自定义余额来源 + 模型选择同步',
  `  const mdProvidersView = () => {`,
  `  // ---------------- 自定义余额来源（每个账户一条）----------------
  // 配置存在 state.balances.custom[providerId]：
  //   { url, credential, header, prefix, fieldPath, currencyPath, enabled }
  // DeepSeek 官方那条不需要配（插件内置）；小米这类控制台接口就靠这里填。
  const mdCustomBalanceConfig = (id) => {
    try {
      const all = state.balances && state.balances.custom ? state.balances.custom : null
      if (!isPlainObject(all)) return null
      const b = all[String(id)]
      if (!isPlainObject(b)) return null
      const url = String(b.url || '').trim()
      if (!url) return null
      const header = String(b.header || 'Authorization').trim() || 'Authorization'
      return {
        url,
        credential: String(b.credential || '').trim(),
        header,
        prefix: b.prefix === undefined ? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '') : String(b.prefix || ''),
        fieldPath: String(b.fieldPath || '').trim(),
        currencyPath: String(b.currencyPath || '').trim(),
        enabled: b.enabled !== false,
      }
    } catch (err) {
      return null
    }
  }

  // 点号/中括号路径取值：balance_infos.0.total_balance、data["balance"]、balance
  const mdPickPath = (obj, p) => {
    if (!p) return undefined
    const parts = String(p)
      .replace(/\\[(\\d+)\\]/g, '.$1')
      .replace(/\\["'?([^"'\\]]+)["'?\\]/g, '.$1')
      .split('.')
      .filter((x) => x !== '')
    let cur = obj
    for (const k of parts) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[k]
    }
    return cur
  }

  // 自动挑余额：优先名字里带 balance/remain/credit/available/quota/total 的数字
  const mdAutoPickBalance = (data) => {
    const found = []
    const walk = (node, p, depth) => {
      if (depth > 6 || node === null || node === undefined) return
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length && i < 50; i++) walk(node[i], p + '.' + i, depth + 1)
        return
      }
      if (typeof node === 'object') {
        for (const k of Object.keys(node)) walk(node[k], p ? p + '.' + k : k, depth + 1)
        return
      }
      const isNum = typeof node === 'number' || (typeof node === 'string' && /^-?\\d+(\\.\\d+)?$/.test(node.trim()))
      if (!isNum) return
      const num = Number(node)
      if (!isFinite(num)) return
      const key = String(p).split('.').pop().toLowerCase()
      let score = 0
      if (/balance|remain|credit|available|quota|total|amount/.test(key)) score += 5
      if (/balance/.test(String(p).toLowerCase())) score += 3
      if (num !== 0) score += 1
      found.push({ value: num, path: p, score })
    }
    walk(data, '', 0)
    found.sort((a, b) => b.score - a.score || String(a.path).length - String(b.path).length)
    return found[0] || null
  }

  const mdHostOf = (url) => {
    try {
      return new URL(url).host
    } catch (err) {
      return String(url).slice(0, 60)
    }
  }

  // 拉一个账户的自定义余额；结果写进该账户的 balance 字段
  const mdFetchCustomBalance = async (id) => {
    const cfg = mdCustomBalanceConfig(id)
    const p = mdProvider(id)
    if (!cfg) return { ok: false, reason: 'no-config' }
    if (!cfg.enabled) return { ok: false, reason: 'disabled' }
    let token = ''
    if (cfg.credential) {
      try {
        const cred = ctx.get('credentials')
        if (cred && typeof cred.resolve === 'function') {
          const c = await cred.resolve(cfg.credential)
          token = (c && (c.value || c.secret)) || ''
        }
      } catch (err) {
        token = ''
      }
      if (!token) {
        p.balanceKnown = false
        p.balanceError = '凭据 ' + cfg.credential + ' 读不到（没配或名字写错）'
        p.balanceUpdatedAt = Date.now()
        return { ok: false, reason: 'no-credential' }
      }
    }
    const headers = {}
    if (token) headers[cfg.header] = cfg.header.toLowerCase() === 'authorization' ? cfg.prefix + token : token
    try {
      const res = await fetch(cfg.url, { headers, signal: AbortSignal.timeout(15000) })
      const text = await res.text()
      let data = null
      try {
        data = JSON.parse(text)
      } catch (err) {
        data = null
      }
      if (!res.ok) {
        p.balanceKnown = false
        p.balanceError = 'HTTP ' + res.status
        p.balanceUpdatedAt = Date.now()
        return { ok: false, reason: 'http', status: res.status }
      }
      if (data === null) {
        p.balanceKnown = false
        p.balanceError = '返回不是 JSON'
        p.balanceUpdatedAt = Date.now()
        return { ok: false, reason: 'not-json' }
      }
      let raw = cfg.fieldPath ? mdPickPath(data, cfg.fieldPath) : undefined
      let usedPath = cfg.fieldPath
      if (raw === undefined || raw === null || raw === '') {
        const auto = mdAutoPickBalance(data)
        if (auto) {
          raw = auto.value
          usedPath = auto.path + '（自动挑的）'
        }
      }
      const num = Number(raw)
      if (!isFinite(num)) {
        p.balanceKnown = false
        p.balanceError = '找不到余额数字（字段路径：' + (cfg.fieldPath || '未填') + '）'
        p.balanceUpdatedAt = Date.now()
        return { ok: false, reason: 'no-number' }
      }
      const curRaw = cfg.currencyPath ? mdPickPath(data, cfg.currencyPath) : undefined
      const cur = String(curRaw === undefined || curRaw === null ? '' : curRaw).toUpperCase()
      p.balanceKnown = true
      p.balance = num
      p.currency = /USD/.test(cur) ? 'USD' : /CNY|RMB/.test(cur) ? 'CNY' : p.currency || 'CNY'
      p.balanceSource = '自定义接口 ' + mdHostOf(cfg.url)
      p.balanceError = ''
      p.balanceUpdatedAt = Date.now()
      return { ok: true, value: num, path: usedPath }
    } catch (err) {
      p.balanceKnown = false
      p.balanceError = String((err && err.message) || err)
      p.balanceUpdatedAt = Date.now()
      return { ok: false, reason: 'throw' }
    }
  }

  // 把所有配了自定义来源的账户刷一遍（含尚未在 providerOrder 里的）
  const mdRefreshCustomBalances = async () => {
    const ids = []
    try {
      for (const id of runtime.providerOrder) if (mdCustomBalanceConfig(id)) ids.push(id)
      const all = state.balances && state.balances.custom ? state.balances.custom : {}
      for (const id of Object.keys(all)) if (ids.indexOf(id) === -1 && mdCustomBalanceConfig(id)) ids.push(id)
    } catch (err) {
      /* 忽略 */
    }
    for (const id of ids) {
      try {
        await mdFetchCustomBalance(id)
      } catch (err) {
        /* 单个失败不影响别的 */
      }
    }
    return ids.length
  }

  // 切换模型即时跟随：读默认模型选择（设置里一点就变，不必等下一轮对话）
  const mdSyncModelSelection = () => {
    try {
      const svc = ctx.get('agentDefaultModel')
      if (!svc || typeof svc.currentSelection !== 'function') return
      const sel = svc.currentSelection()
      if (!sel || !sel.provider) return
      const provider = String(sel.provider)
      const model = String(sel.model || '')
      const cur = runtime.modelCtx || {}
      if (cur.provider === provider && cur.model === model) return
      runtime.modelCtx = { provider, model, at: Date.now(), source: 'default-selection' }
    } catch (err) {
      /* 忽略 */
    }
  }

  const mdProvidersView = () => {`,
)

// 启动时刷一遍 + 状态轮询里同步模型选择
rep(
  'AC2 启动刷自定义来源',
  `    mdRegisterProviders()
    mdRefreshAccount().catch(() => {})`,
  `    mdRegisterProviders()
    mdRefreshAccount().catch(() => {})
    mdSyncModelSelection()
    mdRefreshCustomBalances().catch(() => {})`,
)
rep(
  'AC3 60 秒跟着刷',
  `    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
      mdRefreshAccount().catch(() => {})
    })`,
  `    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
      mdRefreshAccount().catch(() => {})
      mdRefreshCustomBalances().catch(() => {})
    })`,
)
rep(
  'AC4 status 时同步选择',
  `        sendJson(res, 200, {
          ok: true,
          peak: peakInfo(),`,
  `        // 每次状态轮询都对齐一次「当前供应商/模型」——这样在模型列表里一切换，
        // 气泡与「用量」页最多 30 秒就跟着换成那家的余额与消耗（不用等下一轮对话）
        mdSyncModelSelection()
        sendJson(res, 200, {
          ok: true,
          peak: peakInfo(),`,
)

// diag 钩子：按需刷自定义来源（测试与前端刷新按钮用）
rep(
  'AC5 diag 钩子 refreshBalances',
  `        // ?refreshAccount=1 立刻刷一次 DSH 登录账号余额（测试与「用量」页的刷新按钮用）
        try {
          if (/[?&]refreshAccount=1/.test(req.url || '')) await mdRefreshAccount()
        } catch (err) {
          runtime.timerErrors.manualAccount = String((err && err.message) || err)
        }`,
  `        // ?refreshAccount=1 立刻刷一次 DSH 登录账号余额（测试与「用量」页的刷新按钮用）
        try {
          if (/[?&]refreshAccount=1/.test(req.url || '')) await mdRefreshAccount()
        } catch (err) {
          runtime.timerErrors.manualAccount = String((err && err.message) || err)
        }
        // ?refreshBalances=1 立刻把所有自定义余额来源刷一遍
        try {
          if (/[?&]refreshBalances=1/.test(req.url || '')) await mdRefreshCustomBalances()
        } catch (err) {
          runtime.timerErrors.manualBalances = String((err && err.message) || err)
        }`,
)

// 试接口路由（不改配置，只回状态码 / 原始片段 / 候选数字）
rep(
  'AC6 balance-test 路由',
  `    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——`,
  `    // —— 路由：试一个余额接口（只读地请求一次，回状态码 + 原始片段 + 自动挑出的数字与候选）——
    registerRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/balance-test.json',
      handler: async (req, res) => {
        const body = await readBody(req, 1 << 20)
        const url = isPlainObject(body) ? String(body.url || '').trim() : ''
        if (!url) {
          sendJson(res, 400, { ok: false, error: '缺少 url' })
          return
        }
        const credential = isPlainObject(body) ? String(body.credential || '').trim() : ''
        const header = (isPlainObject(body) ? String(body.header || '') : '').trim() || 'Authorization'
        const prefix = isPlainObject(body) && body.prefix !== undefined ? String(body.prefix) : header.toLowerCase() === 'authorization' ? 'Bearer ' : ''
        const fieldPath = isPlainObject(body) ? String(body.fieldPath || '').trim() : ''
        const currencyPath = isPlainObject(body) ? String(body.currencyPath || '').trim() : ''
        let token = ''
        if (credential) {
          try {
            const cred = ctx.get('credentials')
            if (cred && typeof cred.resolve === 'function') {
              const c = await cred.resolve(credential)
              token = (c && (c.value || c.secret)) || ''
            }
          } catch (err) {
            token = ''
          }
        }
        const headers = {}
        if (token) headers[header] = header.toLowerCase() === 'authorization' ? prefix + token : token
        const out = { ok: true, url, header, hasToken: !!token }
        try {
          const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
          out.status = r.status
          const text = await r.text()
          out.bodySnippet = text.slice(0, 1200)
          let data = null
          try {
            data = JSON.parse(text)
          } catch (err) {
            data = null
          }
          out.isJson = data !== null
          if (data !== null) {
            out.candidates = []
            const walk = (node, p, depth) => {
              if (depth > 6 || node === null || node === undefined || out.candidates.length > 40) return
              if (Array.isArray(node)) {
                for (let i = 0; i < node.length && i < 50; i++) walk(node[i], p + '.' + i, depth + 1)
                return
              }
              if (typeof node === 'object') {
                for (const k of Object.keys(node)) walk(node[k], p ? p + '.' + k : k, depth + 1)
                return
              }
              const isNum = typeof node === 'number' || (typeof node === 'string' && /^-?\\d+(\\.\\d+)?$/.test(node.trim()))
              if (isNum) out.candidates.push({ path: p, value: Number(node) })
            }
            walk(data, '', 0)
            const picked = fieldPath ? mdPickPath(data, fieldPath) : undefined
            const auto = mdAutoPickBalance(data)
            out.picked = {
              path: fieldPath || (auto ? auto.path : ''),
              value: picked !== undefined && picked !== null && picked !== '' ? Number(picked) : auto ? auto.value : null,
              auto: !(picked !== undefined && picked !== null && picked !== ''),
            }
            if (currencyPath) out.currency = mdPickPath(data, currencyPath)
          }
        } catch (err) {
          out.ok = false
          out.error = String((err && err.message) || err)
        }
        sendJson(res, 200, out)
      },
    })

    // —— 路由：投递某个闹钟（前端兜底用；同一分钟只投一次，不会重复响）——`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
