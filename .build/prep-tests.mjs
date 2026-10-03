// Build runnable copies of the test suites against the .build candidate.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const B = path.join(ROOT, '.build')

const mount = fs.readFileSync(path.join(ROOT, 'test', 'mount.test.mjs'), 'utf8')
  .replace(`path.join(__dirname, '..', 'lib', 'index.js')`, `path.join(__dirname, 'index.js')`)
  .split('1\\.1\\.0').join('1\\.2\\.9')
  .split('1.1.0').join('1.2.9')
fs.writeFileSync(path.join(B, 'mount.test.mjs'), mount)

const dom = fs.readFileSync(path.join(ROOT, 'test', 'dom.test.mjs'), 'utf8')
  .replace(`path.join(__dirname, '..', 'assets', 'maodie.js')`, `path.join(__dirname, 'frontend.js')`)
fs.writeFileSync(path.join(B, 'dom.test.mjs'), dom)

const contract = fs.readFileSync(path.join(ROOT, 'test', 'contract.test.mjs'), 'utf8')
  .replace(`const root = path.join(__dirname, '..')`, `const root = __dirname
const rootReal = path.join(__dirname, '..')`)
  .replace(`path.join(root, 'assets', 'maodie.js')`, `path.join(root, 'frontend.js')`)
  .replace(`path.join(root, 'lib', 'index.js')`, `path.join(root, 'index.js')`)
fs.writeFileSync(path.join(B, 'contract.test.mjs'), contract)

console.log('prepared .build test suites')
