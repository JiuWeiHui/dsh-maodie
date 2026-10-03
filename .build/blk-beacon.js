    // —— 前端启动回执 + 心跳（诊断用，不设信任栅栏）——
    // 前端脚本 bootUp() 起来后立刻 POST 一次 /maodie/hello，之后每 15s 把健康度
    // POST 到 /maodie/report.json（SSE 状态、收件箱进度、声音播放结果、姿态、槽位…）。
    // 这是唯一能区分「注入没生效 / 注入了但前端报错 / 声音被浏览器或槽位配置掐了」
    // 的 Host 侧证据：全部汇总在 /maodie/diag 里。
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/hello',
      handler: async (req, res) => {
        let payload = null
        try {
          payload = await readBody(req, 4096)
        } catch (err) {
          payload = null
        }
        if (!isPlainObject(payload)) {
          payload = {}
          try {
            const u = new URL(req.url || '/', 'http://127.0.0.1')
            payload.href = u.searchParams.get('href') || ''
            payload.apiBase = u.searchParams.get('apiBase') || ''
            payload.version = u.searchParams.get('version') || ''
          } catch (err) {
            /* 忽略 */
          }
        }
        const clip = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n)
        runtime.helloCount += 1
        runtime.lastHello = {
          at: Date.now(),
          version: clip(payload.version, 40),
          href: clip(payload.href, 300),
          protocol: clip(payload.protocol, 40),
          apiBase: clip(payload.apiBase, 200),
          ua: clip(payload.ua, 240),
          error: clip(payload.error, 300),
        }
        sendJson(res, 200, { ok: true, at: runtime.lastHello.at, count: runtime.helloCount })
      },
    })

    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/report.json',
      handler: async (req, res) => {
        let body = null
        try {
          body = await readBody(req, 256 << 10)
        } catch (err) {
          body = null
        }
        if (!isPlainObject(body)) {
          sendJson(res, 400, { ok: false, error: 'bad-body' })
          return
        }
        const clip = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n)
        const num = (v) => (isFinite(Number(v)) ? Number(v) : 0)
        const sse = isPlainObject(body.sse) ? body.sse : {}
        const inbox = isPlainObject(body.inbox) ? body.inbox : {}
        const audioReport = isPlainObject(body.audio) ? body.audio : {}
        const lastAudio = isPlainObject(audioReport.last) ? audioReport.last : {}
        runtime.reportAt = Date.now()
        runtime.report = {
          at: runtime.reportAt,
          version: clip(body.version, 40),
          href: clip(body.href, 300),
          protocol: clip(body.protocol, 40),
          apiBase: clip(body.apiBase, 200),
          pose: clip(body.pose, 40),
          images: isPlainObject(body.images) ? body.images : null,
          sse: {
            state: clip(sse.state, 40),
            helloAt: num(sse.helloAt),
            lastAt: num(sse.lastAt),
            errors: num(sse.errors),
          },
          inbox: {
            lastSeq: num(inbox.lastSeq),
            lastPollAt: num(inbox.lastPollAt),
            polls: num(inbox.polls),
            errors: num(inbox.errors),
          },
          audio: {
            unlocked: audioReport.unlocked === true,
            contextState: clip(audioReport.contextState, 40),
            volume: num(audioReport.volume),
            last: {
              at: num(lastAudio.at),
              id: clip(lastAudio.id, 80),
              trigger: clip(lastAudio.trigger, 60),
              ok: lastAudio.ok === true,
              error: clip(lastAudio.error, 300),
            },
          },
          slots: Array.isArray(body.slots)
            ? body.slots.slice(0, 20).map((s) => ({
                id: clip(s && s.id, 60),
                name: clip(s && s.name, 60),
                trigger: clip(s && s.trigger, 60),
                enabled: !(s && s.enabled === false),
                pool: num(s && s.pool),
                loop: !!(s && s.loop),
              }))
            : [],
          errors: Array.isArray(body.errors) ? body.errors.slice(0, 10).map((e) => clip(e, 300)) : [],
        }
        sendJson(res, 200, {
          ok: true,
          at: runtime.reportAt,
          version: PLUGIN_VERSION,
          eventSeq: runtime.eventSeq,
          // 顺手把「Host 认为哪些槽位不会出声」回给前端，设置页可以原样显示
          notes: soundWarnings(),
        })
      },
    })

    // —— 事件收件箱：SSE 掉线时前端靠轮询它，保证闹钟/任务完成一定送达 ——
    // 语义：不带 since = 只取当前序号（前端用来「对齐基线」，不会补发历史事件）；
    //       带 since=N = 补发 seq > N 的事件。前端用 seq 去重，SSE 与轮询可以并存。
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/inbox.json',
      handler: (req, res) => {
        const now = Date.now()
        // 只保留最近 2 分钟、最多 60 条，避免刷新页面时把很早的闹钟补发出来
        runtime.inbox = runtime.inbox.filter((x) => x && now - x.at < 120000).slice(-60)
        let since = null
        try {
          const u = new URL(req.url || '/', 'http://x')
          const raw = u.searchParams.get('since')
          if (raw !== null && raw !== '' && isFinite(Number(raw))) since = Number(raw)
        } catch (err) {
          since = null
        }
        const items = since === null ? [] : runtime.inbox.filter((x) => x.seq > since)
        sendJson(res, 200, { ok: true, seq: runtime.eventSeq, items, serverTime: now })
      },
    })

    // —— 闹钟自测：立刻走一遍完整的闹钟投递链路（设置页用，不用等到点）——
    registerRawRoute({
      kind: 'exact',
      path: ROUTE_BASE + '/alarm-test.json',
      handler: (req, res) => {
        const first = Array.isArray(state.alarms) && state.alarms.length > 0 ? state.alarms[0] : null
        const delivered = deliverAlarm({
          id: 'test',
          name: '测试闹钟',
          text: (first && first.text) || '起床',
        })
        sendJson(res, 200, { ok: true, delivered, sseClients: runtime.sseClients.size, eventSeq: runtime.eventSeq })
      },
    })

