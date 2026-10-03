// dom 回归：用量页新增的账号卡片与「余额来源」编辑区
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')
const p = path.join(ROOT, 'test', 'dom.test.mjs')
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

// statusPayload 补 account（1.3.2 的 DSH 登录账号卡片）
rep(
  'AG1 statusPayload 补 account',
  `  native: initPayload.native,
  serverTime: Date.now(),
}`,
  `  account: {
    available: true,
    signedIn: true,
    status: 'credential-stored',
    wallets: [{ currency: 'CNY', balance: 50 }],
    bonusWallets: [{ currency: 'CNY', balance: 5 }],
    usageUrl: 'https://platform.deepseek.com/usage',
    topUpUrl: 'https://platform.deepseek.com/top_up',
    updatedAt: Date.now(),
    error: '',
    source: 'DSH 登录账号（ctx.deepseekAccount）',
    linkedToProvider: false,
  },
  native: initPayload.native,
  serverTime: Date.now(),
}`,
)

// [17] 里追加新断言
rep(
  'AG2 用量页新断言',
  `  check('用量页没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}`,
  `  check('用量页写明「余额是怎么来的」', text.indexOf('余额是怎么来的') !== -1 && text.indexOf('api.deepseek.com/user/balance') !== -1, text.slice(0, 200))
  check('用量页写清自定义来源怎么填', text.indexOf('余额字段') !== -1 && text.indexOf('控制台') !== -1, text.slice(0, 400))
  check(
    'DSH 登录账号卡片：充值余额 + 赠送额度分开显示',
    text.indexOf('DSH 登录账号') !== -1 && text.indexOf('充值余额') !== -1 && text.indexOf('赠送额度') !== -1 && text.indexOf('50.00') !== -1 && text.indexOf('5.00') !== -1,
    text.slice(0, 400),
  )
  check('带官方用量页入口', text.indexOf('platform.deepseek.com/usage') !== -1)
  check('可手动刷新账号/自定义/官方余额', text.indexOf('账号余额') !== -1 && text.indexOf('自定义来源') !== -1 && text.indexOf('官方余额') !== -1)
  const urlInputs = pane ? pane.querySelectorAll('input[placeholder^="地址："]') : []
  check('每个账户有「余额来源」地址填写框', urlInputs.length >= 2, 'count=' + urlInputs.length)
  const testBtns = pane ? Array.from(pane.querySelectorAll('button')).filter((b) => b.textContent === '测试') : []
  check('每个账户有「测试」按钮', testBtns.length >= 2, 'count=' + testBtns.length)
  check('用量页没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}`,
)

fs.writeFileSync(p, s.split('\n').join(eol))
console.log('written test/dom.test.mjs')
