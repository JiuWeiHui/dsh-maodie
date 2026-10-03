// 修 [25] 的期望：
//   * 字段路径写错时会「自动挑」，返回里要标注 auto=true（这是设计，不是错误）
//   * 真正解析不了（不是 JSON）才应报错
//   * 「切换跟随」要用一个与当前不同的模型，否则本来就一样、不会重新标记来源
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

patch(path.join('test', 'mount.test.mjs'), [
  [
    'AE1 加一个「不是 JSON」的打桩地址',
    `  if (u.includes('example.test/balance')) {`,
    `  if (u.includes('example.test/notjson')) {
    return { ok: true, status: 200, text: async () => '<html>nope</html>', json: async () => ({}) }
  }
  if (u.includes('example.test/balance')) {`,
  ],
  [
    'AE2 字段路径写错 → 自动挑 + 标注 auto',
    `  // 3) 没配来源、又没自动挑到字段时，明确报错而不是瞎填
  await callRoute('/maodie/state.json', 'POST', {
    state: { balances: { custom: { 'no-such': { url: 'https://example.test/balance', fieldPath: 'nope.deep' } } } },
  })
  await callRoute('/maodie/diag?refreshBalances=1')
  const provs2 = (await callRoute('/maodie/providers.json')).json()
  const ns = provs2.providers.find((p) => p.id === 'no-such')
  check('字段路径不对时如实报错（不瞎填数字）', !!ns && ns.balance.known === false && String(ns.balance.error).length > 0, JSON.stringify(ns && ns.balance))
  check('错误里说清字段路径', !!ns && String(ns.balance.error).indexOf('字段路径') !== -1, ns && ns.balance.error)`,
    `  // 3) 字段路径写错 → 自动挑（并在返回里说明是自动挑的），不是静默瞎填
  const test2 = (
    await callRoute('/maodie/balance-test.json', 'POST', {
      url: 'https://example.test/balance',
      fieldPath: 'nope.deep',
    })
  ).json()
  check('字段路径写错时自动挑，并标明 auto', !!test2.picked && test2.picked.auto === true && test2.picked.value === 7.5, JSON.stringify(test2.picked))

  // 3b) 真解析不了（不是 JSON）→ 如实报错，不瞎填数字
  await callRoute('/maodie/state.json', 'POST', {
    state: { balances: { custom: { 'no-json': { url: 'https://example.test/notjson', fieldPath: 'data.balance' } } } },
  })
  await callRoute('/maodie/diag?refreshBalances=1')
  const provs2 = (await callRoute('/maodie/providers.json')).json()
  const ns = provs2.providers.find((p) => p.id === 'no-json')
  check('返回不是 JSON 时如实报错（不瞎填数字）', !!ns && ns.balance.known === false && String(ns.balance.error).length > 0, JSON.stringify(ns && ns.balance))
  check('错误里说清原因', !!ns && String(ns.balance.error).indexOf('JSON') !== -1, ns && ns.balance.error)`,
  ],
  [
    'AE3 切换跟随用不同的模型',
    `  defaultModelSelection = { provider: 'xiaomi', model: 'mimo-v2.6-pro' }
  const st = (await callRoute('/maodie/status.json')).json()
  check('状态里跟随默认模型选择', !!st.modelCtx && st.modelCtx.provider === 'xiaomi' && st.modelCtx.model === 'mimo-v2.6-pro', JSON.stringify(st.modelCtx))`,
    `  defaultModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const st = (await callRoute('/maodie/status.json')).json()
  check('状态里跟随默认模型选择（不必等下一轮对话）', !!st.modelCtx && st.modelCtx.provider === 'deepseek-official' && st.modelCtx.model === 'deepseek-v4-pro', JSON.stringify(st.modelCtx))`,
  ],
])
console.log('done')
