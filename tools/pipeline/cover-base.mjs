/*
 * 生成 54 城「开局覆盖率基准」→ tools/src/cover_bases.json
 * ============================================================================
 *
 * 验收改用覆盖率后，需要一个可信的分母：每座城市只保留一条真实线路的前 4 站，
 * 这 4 站在真实步行网络下能覆盖多少人口，取决于城市尺度与站点位置，不能拍脑袋。
 *
 * 做法：用真实引擎逐城开局（经营挑战、旧版全解锁公司），等交通模型就绪后
 * 推进 2 个游戏日，读 `model.daily.coverage`（步行可达地铁的人口占比）。
 *
 * 用法：node tools/pipeline/cover-base.mjs（需要 4180 端口上的 dev server）
 * 输出：tools/src/cover_bases.json  { "<cityId>": 0.0352, ... }
 * build-data.mjs 会把这份基准写进每城的 `coverBase` 字段。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.PORT || 9567)
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-cover')
const OUT = join(ROOT, 'tools', 'src', 'cover_bases.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dataSrc = readFileSync(join(ROOT, 'js', 'data_cities.js'), 'utf8')
const CM = {}
new Function('window', 'CM', dataSrc)({ CM }, CM)
const CITIES = (CM.MAP_LIST || []).map((m) => m.id)
if (!CITIES.length) throw new Error('读不到城市列表')

mkdirSync(PROFILE, { recursive: true })
mkdirSync(dirname(OUT), { recursive: true })
const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', '--disable-extensions',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${PROFILE}`, '--window-size=1680,1050',
  'about:blank',
], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const t = l.filter((x) => x.type === 'page').pop(); if (t) { wsUrl = t.webSocketDebuggerUrl; break } } catch (e) { /* 还没起来 */ }
}
if (!wsUrl) throw new Error('连不上 CDP')
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 })
  if (r.result && r.result.exceptionDetails) return 'ERR ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text)
  return r.result && r.result.result ? r.result.result.value : null
}
await send('Runtime.enable')
await send('Page.enable')

const out = {}
let done = 0
for (const city of CITIES) {
  await send('Page.navigate', { url: BASE })
  await sleep(2300)
  const raw = await evalJs(`(async () => {
    localStorage.clear();
    const seed = CM.Company.create('覆盖率基准', ${JSON.stringify(city)});
    if (seed.ok) CM.Company.setActive(seed.company.id);
    CM.newGame({ map: ${JSON.stringify(city)}, mode: 'challenge', difficulty: 'normal', name: 'cover' });
    for (let i = 0; i < 300 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
    const g = CM.game;
    for (let i = 0; i < 240 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 150));
    const dt = 1 / 12, per = 24 * 12;
    for (let i = 0; i < 2 * per; i++) g.update(dt);
    const d = g.model && g.model.daily ? g.model.daily : {};
    return JSON.stringify({ ok: !!d.ready, coverage: d.coverage || 0, stations: Object.keys(g.net.stations).length });
  })()`)
  try {
    const r = JSON.parse(raw)
    out[city] = r.ok && r.coverage > 0 ? +r.coverage.toFixed(4) : null
    console.log((done + 1) + '/' + CITIES.length + ' ' + city + ' 覆盖 ' + (r.coverage * 100).toFixed(2) + '% 站 ' + r.stations)
  } catch (e) {
    out[city] = null
    console.log((done + 1) + '/' + CITIES.length + ' ' + city + ' 失败：' + String(raw).slice(0, 120))
  }
  done++
}
const bad = Object.keys(out).filter((k) => out[k] == null)
if (bad.length) console.log('警告：' + bad.length + ' 城没有取到覆盖率：' + bad.join(', '))
writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log('写入 ' + OUT)
proc.kill()
process.exit(0)
