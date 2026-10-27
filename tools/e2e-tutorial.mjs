/* 新手教程 + 全国地图 e2e：温州开局不再使用独立青湾地图。
 * 检查：54 城全国图、Wenzhou 选中、缩放/聚合、开始温州教程、
 * 跳过教程后进入 Atlas、全国图速度控制能推进当前城市时间。 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 9496)
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-tut2')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const check = (name, ok, extra) => console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '  ' + extra : ''))
let fails = 0
function ok(name, cond, extra) { if (!cond) fails++; check(name, cond, extra) }

mkdirSync(PROFILE, { recursive: true })
const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', '--disable-extensions',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${PROFILE}`, '--window-size=1680,1050',
  '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const t = l.filter(x => x.type === 'page').pop(); if (t) { wsUrl = t.webSocketDebuggerUrl; break } } catch (e) {}
}
if (!wsUrl) throw new Error('连不上 CDP')
const ws = new WebSocket(wsUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map(); const errors = []
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value || a.description).join(' '))
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION ' + (m.params.exceptionDetails.text || ''))
})
const send = (method, params) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
const evalJs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.exceptionDetails ? 'ERR ' + r.result.exceptionDetails.text : (r.result && r.result.result ? r.result.result.value : null) }
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: BASE }); await sleep(3000)
for (let i = 0; i < 80 && !(await evalJs('!!window.CM')); i++) await sleep(100)

const atlas = JSON.parse(await evalJs(`(async () => {
  localStorage.clear();
  CM.Atlas.open();
  await new Promise(r => setTimeout(r, 450));
  const a = CM.Atlas;
  const out = { cities: (CM.CHINA_ATLAS || {}).cities.length, mapOrder: CM.MAP_ORDER.length,
    tutorialInOrder: CM.MAP_ORDER.indexOf('tutorial'), sel: a.sel,
    canvas: !!a.cv && a.cv.width > 0, hits: (a.hits || []).length };
  a.cam.zoom = 1; a.render();
  out.lowCluster = (a.hits || []).some(h => h.kind === 'cluster');
  a.cam.zoom = 3; a.render();
  out.highCity = (a.hits || []).length > 0 && (a.hits || []).every(h => h.kind === 'city');
  a.cam.zoom = 1; a.render();
  a.sel = 'wenzhou'; a.updateCard();
  out.card = a.card ? a.card.innerText : '';
  const btn = Array.from(document.querySelectorAll('#atlas button')).find(b => (b.innerText || '').includes('开始新手战役'));
  out.btn = !!btn;
  return JSON.stringify(out);
})()`))
ok('全国图加载 54 城', atlas.cities === 54, atlas.cities)
ok('旧青湾教程不在新地图列表', atlas.mapOrder === 54 && atlas.tutorialInOrder < 0, { order: atlas.mapOrder, tutorial: atlas.tutorialInOrder })
ok('Wenzhou 初始选中且画布可点击', atlas.sel === 'wenzhou' && atlas.canvas === true && atlas.hits > 0, atlas)
ok('低缩放启用聚合', atlas.lowCluster === true, atlas)
ok('高缩放拆分为城市点', atlas.highCity === true, atlas)
ok('城市卡片提供开始新手战役', atlas.btn === true && atlas.card.indexOf('开始新手战役') >= 0, atlas.card.slice(0, 120))

const started = JSON.parse(await evalJs(`(async () => {
  const a = CM.Atlas;
  const btn = Array.from(document.querySelectorAll('#atlas button')).find(b => (b.innerText || '').includes('开始新手战役'));
  if (btn) btn.click();
  for (let i = 0; i < 250 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
  for (let i = 0; i < 120 && CM.game && (!CM.game.city.roadGroups || !CM.game.city.roadGroups.length || CM.game.pending); i++) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 800));
  const co = CM.Company.active();
  return JSON.stringify({ map: CM.game && CM.game.mapId, tutorial: CM.game && CM.game.tutorial,
    campaign: !!(co && co.campaign), contract: co && co.campaign && co.campaign.contract,
    branch: co && co.branches.length, atlas: !!document.querySelector('#atlas') });
})()`))
ok('Wenzhou 教程局能启动', started.map === 'wenzhou' && !!started.tutorial, started)
ok('教程局使用真实战役公司', started.campaign === true && started.branch === 1, started)
ok('第一份合同目标是新增 3 站', started.contract && started.contract.target === started.contract.baseline + 3, started.contract)

const skipped = JSON.parse(await evalJs(`(async () => {
  CM.Tutorial.detach(true);
  await new Promise(r => setTimeout(r, 900));
  const co = CM.Company.active();
  const a = CM.Atlas;
  const before = a && CM.game ? CM.game.clock.minute : null;
  const btn = a ? Array.from(document.querySelectorAll('#atlas .atlas-sp')).find(b => (b.innerText || '') === '1×') : null;
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 1600));
  const after = CM.game ? CM.game.clock.minute : null;
  return JSON.stringify({ atlas: !!document.querySelector('#atlas'), tutorialDone: !!(co && co.campaign && co.campaign.tutorialDone),
    before: before, after: after, speed: CM.game && CM.game.speed });
})()`))
ok('跳过教程后进入全国地图', skipped.atlas === true, skipped)
ok('教程完成状态写入公司记录', skipped.tutorialDone === true, skipped)
ok('全国图速度控制推进同一局时间', skipped.speed === 1 && skipped.after > skipped.before, skipped)

if (errors.length) { fails++; console.log('  ✗ console errors', errors.slice(0, 3)) } else check('全程 0 console error', true)
console.log('\\n' + (fails ? ('✗ ' + fails + ' 项失败') : '全部通过'))
proc.kill()
process.exit(fails ? 1 : 0)
