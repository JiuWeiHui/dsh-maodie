// Point the self-heal test's fresh imports at PLUGIN_ENTRY so the suite works both in test/ and in .build/.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const p = path.join(ROOT, 'test', 'mount.test.mjs')
let s = fs.readFileSync(p, 'utf8')
const before = s
s = s
  .split(`pathToFileURL(path.join(__dirname, 'index.js')).href`)
  .join(`pathToFileURL(PLUGIN_ENTRY).href`)
fs.writeFileSync(p, s)
console.log('patched:', before !== s)
for (const line of s.split('\n')) {
  if (line.includes('PLUGIN_ENTRY')) console.log('  ' + line.trim())
}
