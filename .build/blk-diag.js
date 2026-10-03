    // —— 无认证诊断：注入行 / 前端心跳 / 声音配置 / 闹钟排程 一把看全 ——
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/diag',
      handler: (req, res) => {
        const renderIndex =
          ctx.webServer && typeof ctx.webServer.renderIndex === 'function'
            ? ctx.webServer.renderIndex.bind(ctx.webServer)
            : null
        let rendered = false
        let snippet = ''
        let htmlError = ''
        let htmlLength = 0
        if (renderIndex) {
          try {
            const html = renderIndex('<!doctype html><html><head></head><body><div id="root"></div></body></html>')
            htmlLength = html.length
            rendered = html.indexOf(SCRIPT_SRC) !== -1
            const at = html.indexOf(SCRIPT_SRC)
            snippet = at === -1 ? html.slice(-320) : html.slice(Math.max(0, at - 160), at + 160)
          } catch (err) {
            htmlError = String((err && err.message) || err)
          }
        }
        const ourRows = collectOurRows()
        const base = resolveWebBase()
        const lp = localParts(Date.now())
        const bp = bjParts(Date.now())
        const out = {
          ok: true,
          plugin: PLUGIN_VERSION,
          // ① Host 侧事实：这张表里有没有我们那一行（浏览器直连与桌面端共用）
          indexInjection: {
            listenerEnabled: INJECT_CACHE.enabled,
            src: INJECT_CACHE.src,
            rowsInTable: ourRows.length,
            rows: ourRows,
            lastEmitAt: INJECT_CACHE.lastEmitAt,
            lastError: INJECT_CACHE.lastError,
            renderIndexAvailable: !!renderIndex,
            renderedIntoIndexHtml: rendered,
            htmlLength,
            renderError: htmlError,
            snippet,
          },
          // ② 页面侧事实：前端脚本的回执与心跳
          frontend: {
            helloCount: runtime.helloCount,
            lastHello: runtime.lastHello,
            booted: runtime.helloCount > 0,
            reportAt: runtime.reportAt,
            report: runtime.report,
          },
          // ③ 事件通道：SSE 客户端数 / 收件箱序号（闹钟与任务完成走这两条通道）
          events: {
            sseClients: runtime.sseClients.size,
            eventSeq: runtime.eventSeq,
            inboxSize: runtime.inbox.length,
            lastInbox: runtime.inbox.slice(-3),
          },
          // ④ 配置层面的「为什么不出声」
          soundWarnings: soundWarnings(),
          // ⑤ 闹钟排程（本地时间）——到点没响时能一眼看出排程对不对
          alarms: alarmSchedule(),
          // ⑥ 本次消耗（当前会话）
          session: sessionView(),
          usage: usageView(),
          time: {
            localNow: lp.date + ' ' + lp.hhmm,
            localDate: lp.date,
            localWeekday: lp.weekday,
            beijingNow: bp.date + ' ' + String(bp.hour).padStart(2, '0') + ':' + String(bp.minute).padStart(2, '0'),
            timezoneOffsetMin: new Date().getTimezoneOffset(),
          },
          images: {
            total: allImages().length,
            custom: listCustomImages().length,
            poses: state.appearance.poses || {},
          },
          origin: base || '(相对路径 / 同源)',
          scriptTag: (base || '') + INJECT_CACHE.src,
          paths: { stateDir, assets: ASSETS_DIR },
          publicRoutes: [
            ROUTE_BASE + '/maodie.js',
            ROUTE_BASE + '/image',
            ROUTE_BASE + '/images.json',
            ROUTE_BASE + '/sound',
            ROUTE_BASE + '/doctor',
            ROUTE_BASE + '/diag',
            ROUTE_BASE + '/hello',
            ROUTE_BASE + '/report.json',
            ROUTE_BASE + '/inbox.json',
            ROUTE_BASE + '/alarm-test.json',
          ],
          note:
            '桌面端主窗口由 Electron 壳在 Host 启动时调 collectIndexInjections() 拿整张表，' +
            '再经 dshDesktopBoot.ready() 交给页面执行；因此「新增/删除注入行」必须先重启一次桌面端，' +
            '而改 assets/maodie.js 只要刷新页面。frontend.booted=true 表示前端确实在页面里跑起来了。',
          serverTime: Date.now(),
        }
        const body = Buffer.from(JSON.stringify(out, null, 2), 'utf8')
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(body.length),
        })
        res.end(body)
      },
    })

