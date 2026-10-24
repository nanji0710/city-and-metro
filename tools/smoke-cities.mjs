// 批量冒烟：把 54 城里抽一批（大中小各档 + 边界情况）逐个开局，看是否都能起来。
//
// 为什么要批量：单城验证只能证明「这一城」没问题。54 城的格网、区域、片区名、
// 中心点全是 build-data.mjs 现算的，任何一条推导规则在小城上退化都会让那一城开局就崩，
// 而玩家点到的很可能正好是那一城。
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const PORT = Number(process.env.PORT || 9461)
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const OUT = process.argv[2] || 'tools/shots'
mkdirSync(OUT, { recursive: true })

// 抽样覆盖：超大（北京/上海）、大型（武汉/西安）、中型（洛阳/芜湖）、
// 小型（资阳/清远/湘潭）、特别行政区（澳门/香港），以及格网最小的几城。
const SAMPLE = [
  'beijing', 'shanghai', 'chengdu', 'guangzhou',
  'wuhan', 'xian', 'nanjing', 'chongqing',
  'luoyang', 'wuhu', 'kunming', 'dongguan',
  'ziyang', 'qingyuan', 'xiangtan', 'aomen',
]

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch() {
  const args = [
    `--remote-debugging-port=${PORT}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + process.cwd() + '/tools/.edge-smoke',
    '--window-size=1400,900', '--allow-file-access-from-files', 'about:blank',
  ]
  for (const exe of EDGE) {
    try { return spawn(exe, args, { stdio: 'ignore' }) } catch (e) { /* next */ }
  }
  throw new Error('找不到 Edge')
}

async function main() {
  const proc = launch()
  let ws = null
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const t = list.find((x) => x.type === 'page')
      if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); break }
    } catch (e) { /* not ready */ }
  }
  if (!ws) throw new Error('连不上 CDP')
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))

  let id = 0
  const pending = new Map()
  const errors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text)
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description || '').join(' '))
    }
  })
  const send = (method, params) => new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result && r.result.result ? r.result.result.value : null
  }

  await send('Runtime.enable')
  await send('Page.enable')

  const rows = []
  for (const cityId of SAMPLE) {
    errors.length = 0
    await send('Page.navigate', { url: BASE })
    await sleep(1600)
    const r = await evalJs(`(async () => {
      try {
        CM.newGame({ map: ${JSON.stringify(cityId)}, mode: 'challenge', name: 'smoke-${cityId}' })
        // CM.newGame 是异步的（内部 setTimeout 60ms 才真正 useMap + Game.create），
        // 所以必须等 CM.game 出现，不能紧接着读 —— 上一版就是在这里全部误判为「game 未创建」。
        for (let i = 0; i < 120 && !CM.game; i++) await new Promise(r => setTimeout(r, 100))
        const g = CM.game
        if (!g) return { ok: false, why: 'game 未创建（等 12 秒仍未就绪）' }
        // 让生成器跑起来（城市生成是分帧的，给足时间）
        await new Promise(r => setTimeout(r, 3500))
        const c = g.city
        const stations = Object.keys(g.net.stations || {}).length
        const segs = Object.keys(g.net.segments || {}).length
        return {
          ok: true,
          y: g.clock.y,
          pop: Math.round(c.pop.reduce((a, b) => a + b, 0)),
          roads: (c.roadGroups || []).length,
          stations, segs,
          cfgWH: [CM.CFG.W, CM.CFG.H],
        }
      } catch (e) { return { ok: false, why: String(e && e.message || e) } }
    })()`)
    rows.push({ cityId, ...(r || { ok: false, why: 'evaluate 返回空' }), errors: errors.slice(0, 2) })
    console.log(
      (r && r.ok ? 'OK  ' : 'FAIL') + '  ' + cityId.padEnd(12) +
      (r && r.ok
        ? ` y=${r.y} grid=${r.cfgWH[0]}x${r.cfgWH[1]} pop=${(r.pop / 10000).toFixed(0)}万 roads=${r.roads} st=${r.stations}/${r.segs}`
        : `  ${r && r.why}`) +
      (errors.length ? `  ⚠ ${errors.length} err: ${errors[0].slice(0, 80)}` : '')
    )
  }

  const bad = rows.filter((r) => !r.ok || r.errors.length)
  console.log(`\n抽样 ${SAMPLE.length} 城：通过 ${SAMPLE.length - bad.length} / 失败或告警 ${bad.length}`)
  if (bad.length) console.log('问题城市：' + bad.map((r) => r.cityId).join(', '))

  ws.close()
  proc.kill()
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
