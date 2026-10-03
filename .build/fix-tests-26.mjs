// 修 [26] 的三条期望：定时器变成 3 个、坏 digest 要先重新 check 才进 runtime、版本字面量避开 prep-tests 的自动对齐（别用 1.x.y 形式）
import fs from 'node:fs'
import path from 'node:path'
const p = path.join(path.resolve(import.meta.dirname, '..'), 'test', 'mount.test.mjs')
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

// ① 定时器数量：多了 update（每 6 小时）
rep(
  'AW1 定时器断言',
  `  check('登记了 2 个定时器（闹钟巡检 / 余额刷新）', Array.isArray(d.timers) && d.timers.length === 2, JSON.stringify(d.timers))`,
  `  check(
    '登记了定时器（闹钟巡检 / 余额刷新 / 更新检查）',
    Array.isArray(d.timers) && d.timers.length >= 2 && d.timers.some((t) => t.label === 'alarm') && d.timers.some((t) => t.label === 'balance'),
    JSON.stringify(d.timers),
  )
  check('更新检查定时器每 6 小时一次', Array.isArray(d.timers) && d.timers.some((t) => t.label === 'update' && t.ms === 6 * 3600 * 1000), JSON.stringify(d.timers))`,
)

// ② 坏 digest：改完要重新 check 一次，才会进 runtime.update.asset.digest
rep(
  'AW2 坏 digest 前先重新检查',
  `  assetDigest = 'sha256:' + 'f'.repeat(64)
  const bad = (await callRoute('/maodie/update-apply.json', 'POST', {})).json()`,
  `  assetDigest = 'sha256:' + 'f'.repeat(64)
  await callRoute('/maodie/update-check.json') // 让坏 digest 生效
  const bad = (await callRoute('/maodie/update-apply.json', 'POST', {})).json()`,
)

// ③ 版本字面量：用 cur 派生 + 0.0.1 / 99.0.0（都不匹配 prep-tests 的 /1\.\d+\.\d+/）
rep(
  'AW3 版本比较用例',
  `  latestTag = 'v1.3.4'
  check('同版本不算更新', (await callRoute('/maodie/update-check.json')).json().update.available === false)
  latestTag = 'v1.3.2'
  check('更低版本不算更新', (await callRoute('/maodie/update-check.json')).json().update.available === false)
  latestTag = 'v1.3.5'
  check('更高版本才算更新', (await callRoute('/maodie/update-check.json')).json().update.available === true)`,
  `  latestTag = 'v' + view0.update.current
  check('同版本不算更新', (await callRoute('/maodie/update-check.json')).json().update.available === false, latestTag)
  latestTag = 'v0.0.1'
  check('更低版本不算更新', (await callRoute('/maodie/update-check.json')).json().update.available === false, latestTag)
  latestTag = 'v99.0.0'
  check('更高版本才算更新', (await callRoute('/maodie/update-check.json')).json().update.available === true, latestTag)`,
)

fs.writeFileSync(p, s.split('\n').join(eol))
console.log('written test/mount.test.mjs')
