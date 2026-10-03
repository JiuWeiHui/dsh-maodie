// Build runnable copies of the test suites against the .build candidate.
// 版本字面量不再手写历史映射：直接读候选文件的 PLUGIN_VERSION，把测试里的版本统一成它。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const B = path.join(ROOT, '.build')

const candidate = fs.readFileSync(path.join(B, 'index.js'), 'utf8')
const version = (candidate.match(/PLUGIN_VERSION = '([^']+)'/) || [])[1]
if (!version) throw new Error('读不到候选的 PLUGIN_VERSION')
const esc = version.replace(/\./g, '\\.')

// 测试里的版本期望统一到候选版本（形如 1.x.y 的全部替换）
const align = (text) => text.replace(/1\.\d+\.\d+/g, esc)
console.log('align test versions to ' + version)

const mount = align(
  fs
    .readFileSync(path.join(ROOT, 'test', 'mount.test.mjs'), 'utf8')
    .replace(`path.join(__dirname, '..', 'lib', 'index.js')`, `path.join(__dirname, 'index.js')`),
)
fs.writeFileSync(path.join(B, 'mount.test.mjs'), mount)

const dom = fs.readFileSync(path.join(ROOT, 'test', 'dom.test.mjs'), 'utf8')
  .replace(`path.join(__dirname, '..', 'assets', 'maodie.js')`, `path.join(__dirname, 'frontend.js')`)
fs.writeFileSync(path.join(B, 'dom.test.mjs'), dom)

const contract = fs.readFileSync(path.join(ROOT, 'test', 'contract.test.mjs'), 'utf8')
  .replace(
    `const root = path.join(__dirname, '..')`,
    `const root = __dirname
const rootReal = path.join(__dirname, '..')`,
  )
  .replace(`path.join(root, 'assets', 'maodie.js')`, `path.join(root, 'frontend.js')`)
  .replace(`path.join(root, 'lib', 'index.js')`, `path.join(root, 'index.js')`)
fs.writeFileSync(path.join(B, 'contract.test.mjs'), contract)

console.log('prepared .build test suites')
