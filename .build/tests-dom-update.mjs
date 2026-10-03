// dom 回归：设置→关于 的更新面板
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(import.meta.dirname, '..')
const p = path.join(ROOT, 'test', 'dom.test.mjs')
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

// 1) statusPayload 里补 update（前端读的是 status.update）
rep(
  'AY1 statusPayload 补 update',
  `  native: initPayload.native,
  serverTime: Date.now(),
}`,
  `  update: {
    current: '1.3.4',
    latest: '9.9.9',
    available: true,
    checkedAt: Date.now() - 60000,
    checking: false,
    error: '',
    url: 'https://github.com/JiuWeiHui/dsh-maodie/releases/tag/v9.9.9',
    notes: '## 测试版\\n- 新增某功能\\n- 修了某个 bug',
    publishedAt: '2026-10-03T00:00:00Z',
    asset: { name: 'dsh-maodie-9.9.9.tgz', size: 12345678, digest: 'sha256:abc' },
    installedAt: null,
    appliedVersion: '',
    backupDir: '',
    autoCheck: true,
    autoInstall: false,
    hasGit: true,
    target: 'C:/x/dsh-maodie',
  },
  native: initPayload.native,
  serverTime: Date.now(),
}`,
)

// 2) 新增 [18]
rep(
  'AY2 新增 [18] 关于页',
  `  check('用量页没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}`,
  `  check('用量页没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}

console.log('\\n[18] 「关于」页：更新面板')
{
  const tabs = Array.from(win.document.querySelectorAll('.md-set-tab'))
  let idx = -1
  tabs.forEach((t, i) => {
    if (t.textContent === '关于') idx = i
  })
  check('存在「关于」标签页', idx !== -1)
  if (idx >= 0) tabs[idx].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(300)

  const panes = Array.from(win.document.querySelectorAll('.md-set-pane'))
  const pane = idx >= 0 ? panes[idx] : null
  const text = pane ? pane.textContent : ''
  check('关于页渲染出来了', !!pane && text.length > 0)
  check('显示当前版本与最新版本', text.indexOf('当前版本') !== -1 && text.indexOf('1.3.4') !== -1 && text.indexOf('最新版本') !== -1 && text.indexOf('9.9.9（可更新）') !== -1, text.slice(0, 200))
  check('显示最后检查时间（不是「还没检查过」）', text.indexOf('最后检查') !== -1 && text.indexOf('还没检查过') === -1, text.slice(0, 200))
  check('显示更新说明摘要', text.indexOf('更新说明') !== -1 && text.indexOf('新增某功能') !== -1, text.slice(0, 400))
  check('显示安装包与体积', text.indexOf('dsh-maodie-9.9.9.tgz') !== -1 && text.indexOf('11.8 MB') !== -1, text.slice(0, 400))

  const btns = pane ? Array.from(pane.querySelectorAll('button')).map((b) => b.textContent) : []
  check('有「检查更新」按钮', btns.indexOf('检查更新') !== -1, btns.join(','))
  check('有「立即更新」按钮（有新版本时）', btns.indexOf('立即更新') !== -1, btns.join(','))
  check('有「打开发布页」按钮', btns.indexOf('打开发布页') !== -1, btns.join(','))

  const cbs = pane ? Array.from(pane.querySelectorAll('input[type=checkbox]')) : []
  check('有自动检查与自动安装两个开关', cbs.length === 2, 'count=' + cbs.length)
  check('自动检查默认勾上', cbs.length >= 1 && cbs[0].checked === true)
  check('自动安装默认不勾', cbs.length >= 2 && cbs[1].checked === false)
  check('开关有说明文字', text.indexOf('每 6 小时一次') !== -1 && text.indexOf('默认关') !== -1, text.slice(0, 400))
  check('显示更新目标目录并提示 git 工作区', text.indexOf('C:/x/dsh-maodie') !== -1 && text.indexOf('git 工作区') !== -1, text.slice(0, 500))
  check('关于页没有抛异常', pageErrors.length === 0, pageErrors.join(' | '))
}`,
)

fs.writeFileSync(p, s.split('\n').join(eol))
console.log('written test/dom.test.mjs')
