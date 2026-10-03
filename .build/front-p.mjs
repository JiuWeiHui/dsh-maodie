// Frontend patch 13 (1.3.2)：用量页补齐 —— DSH 账号卡片、每账户余额来源编辑 + 测试按钮 + 填写说明
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET = path.join(ROOT, '.build', 'frontend.js')
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

rep('AF1 version', `  var MAODIE_VERSION = '1.3.1'`, `  var MAODIE_VERSION = '1.3.2'`)

// 1) 页面顶部：说明 + 刷新按钮；随后是 DSH 登录账号卡片
rep(
  'AF2 说明 + 账号卡片',
  `    pane.appendChild(el('div', 'md-sub-title', '总消耗（所有账户加总）'))`,
  `    // —— 余额来源说明（用户问过「要填什么网址」，这里直接写清楚）——
    pane.appendChild(el('div', 'md-sub-title', '余额是怎么来的'))
    pane.appendChild(
      el(
        'div',
        'md-dim',
        '① DeepSeek Official（你自己配的 API key）：插件内置官方接口 https://api.deepseek.com/user/balance，用凭据 DEEPSEEK_API_KEY 鉴权，不用你填网址；' +
          '② DeepSeek Account（DSH 登录账号）：走 DSH 自己的账号服务，登录了才有，多给「赠送额度」和官方用量页入口；' +
          '③ 其它供应商（小米等）：DSH 拿不到它的余额，得你自己给一个「能返回余额数字」的地址（下面每个账户卡里有填写框）。',
      ),
    )
    pane.appendChild(
      el(
        'div',
        'md-dim',
        '自定义来源怎么填：地址 = 能返回 JSON 的余额/用量接口；鉴权 = 用哪个环境变量/凭据名（没有就留空）；' +
          '请求头默认 Authorization: Bearer，像小米/控制台那种用 Cookie 的就把请求头改成 Cookie、前缀留空；' +
          '余额字段 = JSON 路径（如 data.balance、balance_infos.0.total_balance），不确定就点「测试」看返回里有哪些候选数字，写错了插件也会自动挑并在结果里标注。',
      ),
    )
    var refreshRow = el('div', 'md-row')
    refreshRow.appendChild(el('span', 'md-dim', '刷新：'))
    refreshRow.appendChild(
      button('账号余额', 'md-btn-mini', function () {
        json(api('/diag?refreshAccount=1')).then(function () {
          renderUsagePane()
        })
      }),
    )
    refreshRow.appendChild(
      button('自定义来源', 'md-btn-mini', function () {
        json(api('/diag?refreshBalances=1')).then(function () {
          renderUsagePane()
        })
      }),
    )
    refreshRow.appendChild(
      button('官方余额', 'md-btn-mini', function () {
        json(api('/status.json?refresh=1')).then(function (r) {
          if (r && r.ok) status = r
          renderUsagePane()
        })
      }),
    )
    pane.appendChild(refreshRow)

    var acct = (provs && provs.account) || null
    pane.appendChild(el('div', 'md-sub-title', 'DSH 登录账号（DeepSeek Account）'))
    var acard = el('div', 'md-set-card')
    if (!acct || acct.available === false) {
      acard.appendChild(el('div', 'md-dim', '这个部署读不到账号服务（不影响 API key 那条余额）'))
      if (acct && acct.error) acard.appendChild(el('div', 'md-dim', acct.error))
    } else if (!acct.signedIn) {
      acard.appendChild(el('div', 'md-row', '未登录：登录 DeepSeek 账号后这里会出现充值余额与赠送额度'))
    } else {
      var w0 = (acct.wallets && acct.wallets[0]) || null
      var b0 = (acct.bonusWallets && acct.bonusWallets[0]) || null
      acard.appendChild(row('充值余额', el('span', 'md-v', w0 ? String(w0.currency) + ' ' + mdMoney(w0.balance) : '--')))
      acard.appendChild(row('赠送额度', el('span', 'md-v', b0 ? String(b0.currency) + ' ' + mdMoney(b0.balance) : '--')))
      acard.appendChild(el('div', 'md-dim', '来源：DSH 登录账号 · 更新 ' + mdClock(acct.updatedAt)))
      if (acct.usageUrl) {
        var linkRow = el('div', 'md-row')
        linkRow.appendChild(el('span', 'md-dim', '官方用量页：'))
        var a = el('a', null, acct.usageUrl)
        a.href = acct.usageUrl
        a.target = '_blank'
        a.rel = 'noreferrer'
        linkRow.appendChild(a)
        acard.appendChild(linkRow)
      }
    }
    pane.appendChild(acard)

    pane.appendChild(el('div', 'md-sub-title', '总消耗（所有账户加总）'))`,
)

// 2) 每个账户卡片里加「余额来源」编辑 + 测试
rep(
  'AF3 每账户余额来源编辑',
  `      if (p.lastTurn) {
        card.appendChild(
          row('本轮', el('span', 'md-v', '¥ ' + mdMoney(p.lastTurn.amount) + ' · ' + fmtTokens(p.lastTurn.tokens || 0) + ' tokens')),
        )
        card.appendChild(el('div', 'md-dim', (p.lastTurn.model || '') + '　' + (p.lastTurn.amountBasis || '')))
      }
      pane.appendChild(card)`,
  `      if (p.lastTurn) {
        card.appendChild(
          row('本轮', el('span', 'md-v', '¥ ' + mdMoney(p.lastTurn.amount) + ' · ' + fmtTokens(p.lastTurn.tokens || 0) + ' tokens')),
        )
        card.appendChild(el('div', 'md-dim', (p.lastTurn.model || '') + '　' + (p.lastTurn.amountBasis || '')))
      }
      // —— 这一家的余额来源（可自定义）——
      if (!state.balances) state.balances = {}
      if (!state.balances.custom) state.balances.custom = {}
      var srcCfg = state.balances.custom[p.id] || {}
      var isOfficial = p.id === 'deepseek-official'
      card.appendChild(el('div', 'md-dim', isOfficial ? '余额来源：内置官方接口（不用填）' : '余额来源：下面填「能返回余额数字」的地址，或留空显示「余额未知」'))
      var srcRow = el('div', 'md-row')
      var srcCtl = el('div', 'md-row-ctl')
      var urlIn = textInput(srcCfg.url || '', null, '地址：https://…（返回 JSON、且含余额数字）')
      urlIn.style.minWidth = '260px'
      srcCtl.appendChild(el('span', 'md-dim', '地址'))
      srcCtl.appendChild(urlIn)
      var credIn = textInput(srcCfg.credential || '', null, '凭据名，如 XIAOMI_API_KEY（没有留空）')
      srcCtl.appendChild(el('span', 'md-dim', '凭据'))
      srcCtl.appendChild(credIn)
      var headerIn = textInput(srcCfg.header || 'Authorization', null, '请求头（Cookie 那种就填 Cookie）')
      srcCtl.appendChild(el('span', 'md-dim', '请求头'))
      srcCtl.appendChild(headerIn)
      srcCtl.appendChild(el('span', 'md-dim', '余额字段'))
      var fieldIn = textInput(srcCfg.fieldPath || '', null, '如 data.balance / balance_infos.0.total_balance')
      srcCtl.appendChild(fieldIn)
      srcCtl.appendChild(el('span', 'md-dim', '币种字段'))
      var curIn = textInput(srcCfg.currencyPath || '', null, '可选，如 data.currency')
      srcCtl.appendChild(curIn)
      srcCtl.appendChild(
        button('保存', 'md-btn-mini', function () {
          var url = String(urlIn.value || '').trim()
          if (!url) {
            delete state.balances.custom[p.id]
          } else {
            state.balances.custom[p.id] = {
              url: url,
              credential: String(credIn.value || '').trim(),
              header: String(headerIn.value || 'Authorization').trim() || 'Authorization',
              fieldPath: String(fieldIn.value || '').trim(),
              currencyPath: String(curIn.value || '').trim(),
            }
          }
          persist()
          renderUsagePane()
        }),
      )
      srcCtl.appendChild(
        button('测试', 'md-btn-mini', function () {
          json(api('/balance-test.json'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: String(urlIn.value || '').trim(),
              credential: String(credIn.value || '').trim(),
              header: String(headerIn.value || 'Authorization').trim() || 'Authorization',
              fieldPath: String(fieldIn.value || '').trim(),
              currencyPath: String(curIn.value || '').trim(),
            }),
          })
            .then(function (r) {
              if (!r || !r.ok) {
                testOut.textContent = '测试失败：' + ((r && r.error) || '未知错误')
                return
              }
              var picked = r.picked || {}
              var cands = (r.candidates || []).slice(0, 6).map(function (c) {
                return c.path + '=' + c.value
              })
              testOut.textContent =
                'HTTP ' + r.status + '（' + (r.isJson ? 'JSON' : '非 JSON') + '）· ' +
                (picked.value === null || picked.value === undefined ? '没认出余额数字' : '认到 ' + picked.path + ' = ' + picked.value + (picked.auto ? '（自动挑的）' : '')) +
                (cands.length ? ' · 候选：' + cands.join('，') : '')
            })
            .catch(function (err) {
              testOut.textContent = '测试失败：' + String((err && err.message) || err)
            })
        }),
      )
      srcRow.appendChild(srcCtl)
      card.appendChild(srcRow)
      var testOut = el('div', 'md-dim', '')
      card.appendChild(testOut)
      pane.appendChild(card)`,
)

fs.writeFileSync(TARGET, s.split('\n').join(eol))
console.log('written', TARGET, s.length, 'chars')
