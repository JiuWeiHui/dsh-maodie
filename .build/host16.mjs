// Host patch 16 (1.3.2 第 1 步)：接入 DSH 登录账号余额（DeepSeek Account）
//   * ctx.get('deepseekAccount') 是可选服务：读不到就只标注"读不到"，绝不影响 API key 那条
//   * getBalance() → 充值钱包 + 赠送钱包（分币种）；getState().links.usageUrl → 官方用量页
//   * 60 秒刷新一次；如果模型列表里有 provider id 带 account 的，把账号余额挂到它身上
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

rep('AA1 version', `const PLUGIN_VERSION = '1.3.1'`, `const PLUGIN_VERSION = '1.3.2'`)

rep(
  'AA2 runtime.account',
  `    providers: {},
    providerOrder: [],`,
  `    providers: {},
    providerOrder: [],
    // DSH 登录账号（DeepSeek Account）的余额视图；未登录/没有账号服务时也保留结构
    account: null,`,
)

rep(
  'AA3 账号读取与视图',
  `  const mdProvidersView = () => {`,
  `  // ---------------- DSH 登录账号（DeepSeek Account）----------------
  // 这一条只有"登录了"才有：走 Host 侧的账号服务，不需要 API key、不需要网址。
  // 它是可选服务，用 ctx.get 取；取不到就只写"读不到"，API key 那条余额照常工作。
  const mdAccountView = () => {
    const a = runtime.account
    if (!a) {
      return {
        available: false,
        signedIn: false,
        status: '',
        wallets: [],
        bonusWallets: [],
        usageUrl: '',
        topUpUrl: '',
        updatedAt: 0,
        error: '还没读取',
        source: 'DSH 登录账号（ctx.deepseekAccount）',
      }
    }
    return {
      available: a.available !== false,
      signedIn: a.signedIn === true,
      status: a.status || '',
      wallets: a.wallets || [],
      bonusWallets: a.bonusWallets || [],
      usageUrl: a.usageUrl || '',
      topUpUrl: a.topUpUrl || '',
      updatedAt: a.updatedAt || 0,
      error: a.error || '',
      source: 'DSH 登录账号（ctx.deepseekAccount）',
    }
  }

  const mdRefreshAccount = async () => {
    try {
      const acct = ctx.get('deepseekAccount')
      if (!acct || typeof acct.getBalance !== 'function') {
        runtime.account = {
          available: false,
          signedIn: false,
          status: '',
          wallets: [],
          bonusWallets: [],
          usageUrl: '',
          topUpUrl: '',
          updatedAt: Date.now(),
          error: '这个部署没有账号服务（没登录也不影响 API key 那条余额）',
        }
        return
      }
      const client = {
        version: String(PLUGIN_VERSION),
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
      let st = null
      if (typeof acct.getState === 'function') {
        try {
          st = await acct.getState()
        } catch (err) {
          st = null
        }
      }
      const signedIn = !!(st && st.status === 'credential-stored')
      let bal = null
      if (signedIn && typeof acct.getBalance === 'function') {
        try {
          bal = await acct.getBalance(client)
        } catch (err) {
          bal = null
        }
      }
      const wallets = []
      const bonus = []
      if (bal && bal.status === 'ready') {
        for (const w of Array.isArray(bal.value) ? bal.value : []) {
          wallets.push({ currency: String((w && w.currency) || 'CNY'), balance: Number(w && w.balance) || 0 })
        }
        for (const w of Array.isArray(bal.bonusWallets) ? bal.bonusWallets : []) {
          bonus.push({ currency: String((w && w.currency) || 'CNY'), balance: Number(w && w.balance) || 0 })
        }
      }
      runtime.account = {
        available: true,
        signedIn,
        status: st && st.status ? String(st.status) : 'unknown',
        wallets,
        bonusWallets: bonus,
        usageUrl: st && st.links ? String(st.links.usageUrl || '') : '',
        topUpUrl: st && st.links ? String(st.links.topUpUrl || '') : '',
        updatedAt: Date.now(),
        error: bal && bal.status === 'failed' ? '账号余额读取失败' : '',
      }
    } catch (err) {
      runtime.account = {
        available: true,
        signedIn: false,
        status: '',
        wallets: [],
        bonusWallets: [],
        usageUrl: '',
        topUpUrl: '',
        updatedAt: Date.now(),
        error: String((err && err.message) || err),
      }
    }
  }

  const mdProvidersView = () => {`,
)

// 视图里带上 account，并把账号余额挂到 id 带 account 的那个 provider 上
rep(
  'AA4 视图带上 account',
  `    return {
      providers: out,
      totals: {`,
  `    const account = mdAccountView()
    let accountLinked = false
    if (account.signedIn && Array.isArray(account.wallets) && account.wallets.length > 0) {
      const primary = account.wallets[0]
      for (const p of out) {
        if (!/account/i.test(String(p.id))) continue
        p.balance.known = true
        p.balance.total = primary.balance
        p.balance.currency = primary.currency
        p.balance.source = 'DSH 登录账号（充值钱包）'
        p.balance.error = ''
        p.balance.updatedAt = account.updatedAt
        accountLinked = true
      }
    }
    return {
      providers: out,
      account: Object.assign({ linkedToProvider: accountLinked }, account),
      totals: {`,
)

// 启动 + 每 60 秒刷新
rep(
  'AA5 启动时读一次',
  `    mdRegisterProviders()`,
  `    mdRegisterProviders()
    mdRefreshAccount().catch(() => {})`,
)
rep(
  'AA6 跟随余额刷新',
  `    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
    })`,
  `    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
      mdRefreshAccount().catch(() => {})
    })`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
