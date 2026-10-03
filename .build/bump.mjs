// Bump the release version everywhere it is asserted (all file I/O through Node, never PowerShell pipes).
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const FROM = process.argv[2] || '1.2.0'
const TO = process.argv[3] || '1.2.1'
const ESC_FROM = FROM.replace(/\./g, '\\.')
const ESC_TO = TO.replace(/\./g, '\\.')

const files = ['package.json', 'test/mount.test.mjs', 'test/dom.test.mjs']
for (const rel of files) {
  const p = path.join(ROOT, rel)
  let s = fs.readFileSync(p, 'utf8')
  const before = s
  s = s.split(ESC_FROM).join(ESC_TO).split(FROM).join(TO)
  if (s !== before) {
    fs.writeFileSync(p, s)
    console.log('bumped', rel)
  } else {
    console.log('unchanged', rel)
  }
}
