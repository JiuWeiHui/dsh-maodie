// Host 侧收尾修：① 定时器挪到 every 所在作用域（start 里用 setTimeout/unref，避免 TDZ）
//                ② 更新目标目录走 mdUpdateTarget()（测试可覆盖）
//                ③ 版本三处（含测试期望）→ 1.3.4
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

function patch(rel, pairs) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  const eol = s.includes('\r\n') ? '\r\n' : '\n'
  s = s.split('\r\n').join('\n')
  for (const [name, from, to, expect] of pairs) {
    const n = s.split(from).length - 1
    if (expect !== undefined && n !== expect) {
      console.error('MISMATCH [' + rel + ' ' + name + '] found=' + n + ' expected=' + expect)
      process.exit(1)
    }
    if (n === 0) {
      console.log('  (跳过，没找到) ' + rel + ' :: ' + name)
      continue
    }
    s = s.split(from).join(to)
    console.log('  ' + rel + ' :: ' + name + ' ×' + n)
  }
  fs.writeFileSync(p, s.split('\n').join(eol))
}

console.log('=== ① 启动检查不再用 every（改 setTimeout + unref） ===')
patch(path.join('.build', 'index.js'), [
  [
    'AU3b 启动检查改为 setTimeout',
    `    // 检查更新：启动时一次 + 每 6 小时一次（可在 设置→关于 关掉自动检查）
    if (mdUpdateCfg().autoCheck) mdCheckUpdate().catch(() => {})
    every('update', 6 * 3600 * 1000, () => {
      if (mdUpdateCfg().autoCheck) mdCheckUpdate().catch(() => {})
    })`,
    `    // 检查更新：启动后稍等一会儿查一次（避免和启动抢网络）；定时那部分注册在计时器作用域里
    setTimeout(() => {
      if (mdUpdateCfg().autoCheck) mdCheckUpdate().catch(() => {})
    }, 3000).unref?.()`,
  ],
  [
    'AU13 计时器作用域里注册 6 小时一次',
    `    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
      mdRefreshAccount().catch(() => {})
      mdRefreshCustomBalances().catch(() => {})
    })`,
    `    every('balance', 60000, () => {
      fetchBalance().catch(() => {})
      mdRefreshAccount().catch(() => {})
      mdRefreshCustomBalances().catch(() => {})
    })
    // 每 6 小时检查一次更新（可在 设置→关于 关掉自动检查）
    every('update', 6 * 3600 * 1000, () => {
      if (mdUpdateCfg().autoCheck) mdCheckUpdate().catch(() => {})
    })`,
  ],
])

console.log('=== ② 更新目标目录可覆盖（测试用） ===')
patch(path.join('.build', 'index.js'), [
  [
    'AU7 目标目录函数',
    `  const mdUpdateView = () => {`,
    `  // 更新写到哪个目录：默认本插件自己的目录；MAODIE_UPDATE_TARGET 仅供测试/高级用法覆盖
  const mdUpdateTarget = () => process.env.MAODIE_UPDATE_TARGET || PACKAGE_ROOT

  const mdUpdateView = () => {`,
    1,
  ],
  ['AU8a hasGit 用 target', `      hasGit = fs.existsSync(path.join(PACKAGE_ROOT, '.git'))`, `      hasGit = fs.existsSync(path.join(mdUpdateTarget(), '.git'))`],
  ['AU8b view 的 target 字段', `      target: PACKAGE_ROOT,`, `      target: mdUpdateTarget(),`],
  ['AU9 安全阀用 target', `      const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))`, `      const pkg = JSON.parse(fs.readFileSync(path.join(mdUpdateTarget(), 'package.json'), 'utf8'))`],
  ['AU10 预演报告 target', `files, target: PACKAGE_ROOT, note:`, `files, target: mdUpdateTarget(), note:`],
  ['AU11 备份目录', `path.join(PACKAGE_ROOT, '.update-backup-' + PLUGIN_VERSION)`, `path.join(mdUpdateTarget(), '.update-backup-' + PLUGIN_VERSION)`],
  ['AU12 写入路径', `const dest = path.join(PACKAGE_ROOT, p.path)`, `const dest = path.join(mdUpdateTarget(), p.path)`],
])

console.log('=== ③ 版本 → 1.3.4（含测试期望） ===')
for (const rel of ['.build/index.js', '.build/frontend.js', 'test/mount.test.mjs', 'test/dom.test.mjs']) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) continue
  let s = fs.readFileSync(p, 'utf8')
  const before = s
  s = s.split('1\\.3\\.3').join('1\\.3\\.4').split('1.3.3').join('1.3.4')
  if (s !== before) {
    fs.writeFileSync(p, s)
    console.log('  ' + rel + ' -> 1.3.4')
  }
}
const pj = path.join(ROOT, 'package.json')
const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
j.version = '1.3.4'
fs.writeFileSync(pj, JSON.stringify(j, null, 2) + '\n')
console.log('  package.json -> 1.3.4')
