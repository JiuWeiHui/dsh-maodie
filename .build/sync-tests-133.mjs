// 包名/版本变更后的测试同步：
//   1) 版本字面量 1.3.2 -> 1.3.3
//   2) 包名断言 'maodie' -> 'dsh-maodie'（第 284 / 299 行两处；路由 /maodie/... 不动）
//   3) prep-tests.mjs 改成「从候选文件读版本」，以后不再需要手改历史映射
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

const bump = (rel, from, to) =>
  patch(rel, [
    [`version ${from} -> ${to}`, `1\\.${from.split('.').slice(1).join('\\.')}`, `1\\.${to.split('.').slice(1).join('\\.')}`],
    [`plain ${from} -> ${to}`, from, to],
  ])

bump('test/mount.test.mjs', '1.3.2', '1.3.3')
bump('test/dom.test.mjs', '1.3.2', '1.3.3')

patch('test/mount.test.mjs', [
  [
    'name 断言（package.json）',
    `check('name 是 maodie', pkg && pkg.name === 'maodie', String(pkg && pkg.name))`,
    `check('name 是 dsh-maodie', pkg && pkg.name === 'dsh-maodie', String(pkg && pkg.name))`,
  ],
  [
    'name 断言（插件实例）',
    `check('插件导出 name 为 maodie', instance && instance.name === 'maodie', String(instance && instance.name))`,
    `check('插件导出 name 为 maodie（运行时插件名，与 npm 包名 dsh-maodie 不同）', instance && instance.name === 'maodie', String(instance && instance.name))`,
  ],
])

// prep-tests：版本映射改成动态读候选文件的 PLUGIN_VERSION
const prep = `// Build runnable copies of the test suites against the .build candidate.
// 版本字面量不再手写历史映射：直接读候选文件里的 PLUGIN_VERSION，把测试里的旧版本替换掉。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const B = path.join(ROOT, '.build')

const candidate = fs.readFileSync(path.join(B, 'index.js'), 'utf8')
const version = (candidate.match(/PLUGIN_VERSION = '([^']+)'/) || [])[1]
if (!version) throw new Error('读不到候选的 PLUGIN_VERSION')
const esc = version.replace(/\\./g, '\\\\.')

// 把所有形如 1.x.y 的版本字面量统一到候选版本（测试里的期望值）
const align = (text) => text.replace(/1\\.\\d+\\.\\d+/g, esc).split(esc).join(version)
console.log('align test versions to ' + version)

const mount = align(
  fs
    .readFileSync(path.join(ROOT, 'test', 'mount.test.mjs'), 'utf8')
    .replace(\`path.join(__dirname, '..', 'lib', 'index.js')\`, \`path.join(__dirname, 'index.js')\`),
)
fs.writeFileSync(path.join(B, 'mount.test.mjs'), mount)

const dom = fs.readFileSync(path.join(ROOT, 'test', 'dom.test.mjs'), 'utf8')
  .replace(\`path.join(__dirname, '..', 'assets', 'maodie.js')\`, \`path.join(__dirname, 'frontend.js')\`)
fs.writeFileSync(path.join(B, 'dom.test.mjs'), dom)

const contract = fs.readFileSync(path.join(ROOT, 'test', 'contract.test.mjs'), 'utf8')
  .replace(
    \`const root = path.join(__dirname, '..')\`,
    \`const root = __dirname
const rootReal = path.join(__dirname, '..')\`,
  )
  .replace(\`path.join(root, 'assets', 'maodie.js')\`, \`path.join(root, 'frontend.js')\`)
  .replace(\`path.join(root, 'lib', 'index.js')\`, \`path.join(root, 'index.js')\`)
fs.writeFileSync(path.join(B, 'contract.test.mjs'), contract)

console.log('prepared .build test suites')
`
fs.writeFileSync(path.join(ROOT, '.build', 'prep-tests.mjs'), prep)
console.log('ok  prep-tests.mjs 改成动态版本')
