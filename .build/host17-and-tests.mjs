// 1.3.2 第 2 步：给 diag 加 ?refreshAccount=1（可按需刷账号余额，测试与前端刷新按钮都用它）+ 回归测试
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

patch(path.join('.build', 'index.js'), [
  [
    'AB1 diag 支持 refreshAccount',
    `      handler: (req, res) => {
        // ?runAlarmSweep=1 手动跑一次闹钟巡检（诊断 / 测试用，不改任何配置）
        try {
          if (/[?&]runAlarmSweep=1/.test(req.url || '')) checkAlarms()
        } catch (err) {
          runtime.timerErrors.manualSweep = String((err && err.message) || err)
        }`,
    `      handler: async (req, res) => {
        // ?runAlarmSweep=1 手动跑一次闹钟巡检（诊断 / 测试用，不改任何配置）
        try {
          if (/[?&]runAlarmSweep=1/.test(req.url || '')) checkAlarms()
        } catch (err) {
          runtime.timerErrors.manualSweep = String((err && err.message) || err)
        }
        // ?refreshAccount=1 立刻刷一次 DSH 登录账号余额（测试与「用量」页的刷新按钮用）
        try {
          if (/[?&]refreshAccount=1/.test(req.url || '')) await mdRefreshAccount()
        } catch (err) {
          runtime.timerErrors.manualAccount = String((err && err.message) || err)
        }`,
  ],
])

patch(path.join('test', 'mount.test.mjs'), [
  [
    'AB2 假 ctx 支持账号服务',
    `    if (name === 'credentials') {
      return {
        async resolve(key) {
          if (key === 'DEEPSEEK_API_KEY') return { value: 'test-key' }
          return undefined
        },
      }
    }
    return undefined`,
    `    if (name === 'credentials') {
      return {
        async resolve(key) {
          if (key === 'DEEPSEEK_API_KEY') return { value: 'test-key' }
          return undefined
        },
      }
    }
    if (name === 'deepseekAccount') {
      if (!accountService) return undefined
      return {
        async getState() {
          return {
            status: accountSignedIn ? 'credential-stored' : 'signed-out',
            links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
            attempt: null,
          }
        },
        async getBalance() {
          if (!accountSignedIn) return null
          return {
            status: 'ready',
            value: [{ currency: 'CNY', balance: '50.00' }],
            bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
          }
        },
      }
    }
    return undefined`,
  ],
  [
    'AB3 开关变量',
    `let fenceMode = 'allow'`,
    `let fenceMode = 'allow'
let accountService = false
let accountSignedIn = false`,
  ],
  [
    'AB4 新增 [24] 账号余额回归',
    `// ---------------------------------------------------------------- 收尾
globalThis.fetch = realFetch`,
    `console.log('\\n[24] DSH 登录账号余额（DeepSeek Account；官方 API key 那条不受影响）')
{
  // 1) 没有账号服务时：如实标注，不影响 API key 那条
  let provs = (await callRoute('/maodie/providers.json')).json()
  check('没有账号服务时如实标注', !!provs.account && provs.account.available === false && provs.account.signedIn === false, JSON.stringify(provs.account))
  const official0 = provs.providers.find((p) => p.id === 'deepseek-official')
  check('API key 那条余额照常工作（不受账号服务影响）', !!official0, JSON.stringify(provs.providers.map((p) => p.id)))

  // 2) 有账号服务但未登录
  accountService = true
  accountSignedIn = false
  await callRoute('/maodie/diag?refreshAccount=1')
  provs = (await callRoute('/maodie/providers.json')).json()
  check('未登录时标记 signedIn=false', !!provs.account && provs.account.available === true && provs.account.signedIn === false, JSON.stringify(provs.account))
  check('未登录时不给钱包数字', Array.isArray(provs.account.wallets) && provs.account.wallets.length === 0)
  check('未登录也带官方用量页入口', typeof provs.account.usageUrl === 'string', provs.account.usageUrl)

  // 3) 登录后：充值钱包 + 赠送钱包分开给
  accountSignedIn = true
  await callRoute('/maodie/diag?refreshAccount=1')
  provs = (await callRoute('/maodie/providers.json')).json()
  check('登录后 signedIn=true', !!provs.account && provs.account.signedIn === true, JSON.stringify(provs.account))
  check('充值钱包拿到数字', !!provs.account.wallets[0] && provs.account.wallets[0].balance === 50, JSON.stringify(provs.account.wallets))
  check('赠送钱包单独给', !!provs.account.bonusWallets[0] && provs.account.bonusWallets[0].balance === 5, JSON.stringify(provs.account.bonusWallets))
  check('带官方用量页地址', provs.account.usageUrl.indexOf('platform.deepseek.com') !== -1, provs.account.usageUrl)
  check('来源标注清楚', String(provs.account.source).indexOf('登录账号') !== -1, provs.account.source)
  // 没有任何 provider id 带 account 时，不应强行改别的账户
  check('不会把账号余额冒充别的账户', provs.account.linkedToProvider === false, String(provs.account.linkedToProvider))
}

// ---------------------------------------------------------------- 收尾
globalThis.fetch = realFetch`,
  ],
])
console.log('done')
