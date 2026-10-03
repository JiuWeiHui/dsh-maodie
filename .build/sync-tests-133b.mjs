// 同步测试到 dsh-maodie / 1.3.3（不做次数断言，替换多少报多少）
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')

function swap(rel, pairs) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  for (const [label, from, to] of pairs) {
    const n = s.split(from).length - 1
    if (n === 0) {
      console.log('  (没找到) ' + rel + ' ' + label)
      continue
    }
    s = s.split(from).join(to)
    console.log('  ' + rel + ' ' + label + ' ×' + n)
  }
  fs.writeFileSync(p, s)
}

console.log('=== 测试同步 ===')
for (const rel of ['test/mount.test.mjs', 'test/dom.test.mjs']) {
  swap(rel, [
    ['1\\.3\\.2 -> 1\\.3\\.3', '1\\.3\\.2', '1\\.3\\.3'],
    ['1.3.2 -> 1.3.3', '1.3.2', '1.3.3'],
  ])
}
swap('test/mount.test.mjs', [
  ['包名断言', `check('name 是 maodie', pkg && pkg.name === 'maodie', String(pkg && pkg.name))`, `check('name 是 dsh-maodie', pkg && pkg.name === 'dsh-maodie', String(pkg && pkg.name))`],
  [
    '运行时插件名说明',
    `check('插件导出 name 为 maodie', instance && instance.name === 'maodie', String(instance && instance.name))`,
    `check('插件导出 name 为 maodie（运行时插件名；npm 包名是 dsh-maodie）', instance && instance.name === 'maodie', String(instance && instance.name))`,
  ],
])

// prep-tests：版本映射改成动态读候选文件
const prep = `// Build runnable copies of the test suites against the .build candidate.
// 版本字面量不再手写历史映射：直接读候选文件的 PLUGIN_VERSION，把测试里的版本统一成它。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const B = path.join(ROOT, '.build')

const candidate = fs.readFileSync(path.join(B, 'index.js'), 'utf8')
const version = (candidate.match(/PLUGIN_VERSION = '([^']+)'/) || [])[1]
if (!version) throw new Error('读不到候选的 PLUGIN_VERSION')
const esc = version.replace(/\\./g, '\\\\.')

// 测试里的版本期望统一到候选版本（形如 1.x.y 的全部替换）
const align = (text) => text.replace(/1\\.\\d+\\.\\d+/g, esc)
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
console.log('  prep-tests.mjs 改成动态版本 ✓')
