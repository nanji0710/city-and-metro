/**
 * 战役端到端核查：唯一入门图温州 → 锁图 → 公司池解锁 → 进入新城 → 后台补结算 → 注资。
 * 旧版全解锁公司的接入费链路仍由 e2e-company.mjs 覆盖。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9497
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-campaign-e2e')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (name, extra) => { pass++; console.log('✓ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const no = (name, extra) => { fail++; console.log('✗ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const check = (name, cond, extra) => (cond ? ok(name, extra) : no(name, extra))
const jp = (s, fb) => { try { return JSON.parse(s) } catch (e) { return fb || {} } }

mkdirSync(PROFILE, { recursive: true })
let proc = null
for (const exe of EDGE) {
  try {
    proc = spawn(exe, [
      `--remote-debugging-port=${PORT}`,
      '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${PROFILE}`, '--window-size=1680,1050',
      '--allow-file-access-from-files', 'about:blank',
    ], { stdio: 'ignore' })
    break
  } catch (e) { /* next */ }
}
if (!proc) throw new Error('找不到 Edge')
let wsUrl = null
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const t = list.filter((x) => x.type === 'page').pop()
    if (t) { wsUrl = t.webSocketDebuggerUrl; break }
  } catch (e) { /* not ready */ }
}
if (!wsUrl) throw new Error('连不上 CDP')
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push((m.params.exceptionDetails || {}).text || 'exception')
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '))
})
const send = (method, params) => new Promise((res) => {
  const n = ++id
  pending.set(n, res)
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result && r.result.exceptionDetails) return 'ERR ' + r.result.exceptionDetails.text
  return r.result && r.result.result ? r.result.result.value : null
}

async function boot() {
  await send('Page.navigate', { url: BASE })
  await sleep(2200)
  for (let i = 0; i < 80 && !(await evalJs('!!window.CM')); i++) await sleep(100)
}

await send('Runtime.enable')
await send('Page.enable')
await boot()
await evalJs(`(() => { try { localStorage.removeItem('cm1.companies'); localStorage.removeItem('cm1.companyActive'); } catch (e) {} return 1; })()`)
await boot()

// 1. 无公司时只有入门图温州 + 教程可开局
const pre = jp(await evalJs(`(() => {
  const co = CM.Company.active();
  const locked = CM.MAP_ORDER.filter(id => !CM.Company.canStartMap(co, id, 'challenge'));
  return JSON.stringify({ co: !!co, starters: CM.Company.STARTERS.length,
    locked: locked.length, freeBeijing: CM.Company.canStartMap(co, 'beijing', 'free') });
})()`))
check('无公司时战役只开放入门图温州', pre.co === false && pre.starters === 1 && pre.locked === 53, pre)
check('自由建造仍可选择未解锁城市', pre.freeBeijing === true, pre)

// 2. 从唯一入门图温州开始战役
const started = jp(await evalJs(`(async () => {
  CM.newGame({ map: 'wenzhou', mode: 'challenge', difficulty: 'easy', name: '战役核查' });
  for (let i = 0; i < 160 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
  const g = CM.game;
  for (let i = 0; i < 100 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
  await CM.ui.doAutosave(true);
  await new Promise(r => setTimeout(r, 600));
  CM.ui.updateTop();
  const co = CM.Company.active();
  const goal = document.querySelector('.goalpill');
  return JSON.stringify({ map: g.mapId, lines: Object.keys(g.net.lines).length,
    pool: co.pool, branches: co.branches.map(b => b.mapId),
    unlocked: co.campaign.unlocked, ezhou: CM.Company.canStartMap(co, 'ezhou', 'challenge'),
    goal: !!goal && !goal.classList.contains('hidden'), goalText: goal ? goal.innerText.trim() : '' });
})()`))
check('温州战役开局成功', started.map === 'wenzhou' && started.lines === 1, started)
check('战役公司初始池 5 亿', started.pool === 50000, started)
check('开局城市自动登记为分部', Array.isArray(started.branches) && started.branches[0] === 'wenzhou', started)
check('只有一张入门图默认解锁', Array.isArray(started.unlocked) && started.unlocked.length === 1 && started.unlocked[0] === 'wenzhou', started)
check('鄂州默认锁定', started.ezhou === false, started)
check('对局内 HUD 显示第一份合同', started.goal === true && started.goalText.indexOf('/') >= 0, started)

// 2b. 地图指纹与内容指纹不一致的存档必须拒绝
const fpGuard = jp(await evalJs(`(() => {
  const makeBad = (field) => {
    const env = CM.Save.envelope(CM.game);
    const payload = JSON.parse(env.body);
    payload.meta[field] = 'tampered-' + field;
    const body = JSON.stringify(payload);
    const bad = Object.assign({}, env, { body: body, checksum: CM.U.fnv(body) });
    let message = '';
    try { CM.Save.parseEnvelope(JSON.stringify(bad)); } catch (e) { message = e.message || String(e); }
    return message;
  };
  return JSON.stringify({ map: makeBad('mapFp'), content: makeBad('contentFp') });
})()`))
check('地图底图指纹不一致的存档会被拒绝', fpGuard.map.indexOf('底图不一致') >= 0, fpGuard)
check('地图内容指纹不一致的存档会被拒绝', fpGuard.content.indexOf('玩法数据不一致') >= 0, fpGuard)

// 3. 公司面板：51 个未进驻城市，鄂州显示解锁
const panel = jp(await evalJs(`(async () => {
  CM.ui.openTop('company');
  await new Promise(r => setTimeout(r, 700));
  const rows = Array.from(document.querySelectorAll('.co-jrow'));
  const ezhou = rows.find(r => r.dataset.map === 'ezhou');
  const pageText = document.querySelector('.co-page') ? document.querySelector('.co-page').innerText : '';
  return JSON.stringify({ rows: rows.length, hasAomen: !!ezhou,
    btn: ezhou ? (ezhou.querySelector('button') || {}).innerText || '' : '',
    poolText: pageText.indexOf('公司池') >= 0,
    preview: pageText.indexOf('下次月结预计上缴') >= 0,
    contract: pageText.indexOf('第一份公司合同') >= 0,
    report: pageText.indexOf('全公司月报') >= 0 && pageText.indexOf('近 12 个月') >= 0,
    backup: pageText.indexOf('导出公司记录') >= 0 && pageText.indexOf('导入公司记录') >= 0,
    atlasEntry: pageText.indexOf('打开全国战略地图') >= 0 });
})()`))
check('公司面板出现地图解锁列表', panel.rows === 53 && panel.hasAomen === true && panel.poolText === true, panel)
check('第一份合同完成前新城按钮为未达标（解锁资格门槛）', panel.btn.indexOf('未达标') >= 0, panel)
check('公司面板显示月结预计上缴', panel.preview === true, panel)
check('公司面板显示第一份公司合同', panel.contract === true, panel)
check('公司面板显示全公司月报', panel.report === true, panel)
check('公司面板提供公司记录备份', panel.backup === true, panel)
check('公司面板提供全国地图统一入口', panel.atlasEntry === true, panel)

// 4. 完成第一份合同（+3 站）→ 拿到解锁资格；再补 4 站触发温州验收（奖金进池、资格再 +1）
const contract = jp(await evalJs(`(async () => {
  const g = CM.game;
  if (!g || g.mapId !== 'wenzhou') return JSON.stringify({ err: 'NOT-WENZHOU' });
  const M = CM.Metro;
  const lineId = Object.keys(g.net.lines)[0];
  const addStations = (n) => {
    const er = g.edit((net) => {
      for (let k = 0; k < n; k++) {
        let near = null, nd = -1;
        for (const sid0 in net.stations) { const s = net.stations[sid0]; const d = CM.U.dist(64, 64, s.x, s.y); if (d > nd) { nd = d; near = sid0; } }
        const sid = M.addStation(net, 60 + k * 3, 58, { size: 'S', type: 'surface' }, g.city);
        const r = M.addSegment(net, lineId, near, sid, [], 'surface');
        if (r && r.error) throw new Error(r.error);
      }
    });
    if (er && er.error) return er.error;
    g.net = JSON.parse(JSON.stringify(g.draft.net)); g.draft = null;
    return null;
  };
  // 合同：4 → 7 站
  const e1 = addStations(3);
  if (e1) return JSON.stringify({ err: 'EDIT1 ' + e1 });
  const cr = CM.Company.checkStarterContract(g);
  // 温州验收：7 → 11 站（开局 4 + Δ7，36 站 × 20%）
  const e2 = addStations(4);
  if (e2) return JSON.stringify({ err: 'EDIT2 ' + e2 });
  const acc = CM.Company.checkAcceptance(g);
  const co = CM.Company.active();
  return JSON.stringify({ contract: cr, accept: acc, pool: co.pool, quota: CM.Company.openQuota(co),
    canEzhou: CM.Company.canStartMap(co, 'ezhou', 'challenge'),
    need: CM.Company.acceptNeed('wenzhou'), stations: Object.keys(g.net.stations).length });
})()`))
check('第一份合同完成奖励 7 亿进池', contract.contract && contract.contract.ok === true && contract.contract.reward === 70000, contract)
check('温州线网达 11 站触发验收（奖金 4 亿进池）', contract.accept && contract.accept.ok === true &&
  contract.accept.reward === 40000 && contract.accept.have === 11 && contract.accept.need === 11, contract)
check('验收后解锁资格为 1（合同不发资格，每图一次）', contract.quota === 1 && contract.canEzhou === true, contract)

// 4b. 从公司面板解锁鄂州：资格已够，公司池只付 0.5 亿开通费
const unlocked = jp(await evalJs(`(async () => {
  try { CM.ui.closePanel(true); } catch (e) {}
  CM.ui.openTop('company');
  await new Promise(r => setTimeout(r, 700));
  const rows = Array.from(document.querySelectorAll('.co-jrow'));
  const ezhou = rows.find(r => r.dataset.map === 'ezhou');
  (ezhou.querySelector('button')).click();
  await new Promise(r => setTimeout(r, 500));
  const okBtn = Array.from(document.querySelectorAll('.screen button, .card button')).find(b => (b.innerText || '').indexOf('确认解锁') >= 0);
  const txt = okBtn && okBtn.closest('.card') ? okBtn.closest('.card').innerText : '';
  if (!okBtn) return JSON.stringify({ err: 'NO-OK', txt: txt.slice(0, 120) });
  okBtn.click();
  await new Promise(r => setTimeout(r, 700));
  const co = CM.Company.active();
  return JSON.stringify({ fee: txt.indexOf('开通费') >= 0, capital: txt.indexOf('市政府') >= 0, pool: co.pool,
    unlocked: CM.Company.isUnlocked(co, 'ezhou'), can: CM.Company.canStartMap(co, 'ezhou', 'challenge') });
})()`))
check('解锁确认框说明开通费与市政府启动金', unlocked.fee === true && unlocked.capital === true, unlocked)
check('解锁后公司池只扣 0.5 亿开通费（合同+验收后为 16 亿）', unlocked.pool === 155000, unlocked)
check('鄂州变为已解锁', unlocked.unlocked === true && unlocked.can === true, unlocked)

// 5. 从公司面板开始鄂州；启动金 6 亿由市政府资本金注入（不从池扣）
const started2 = jp(await evalJs(`(async () => {
  const rows = Array.from(document.querySelectorAll('.co-jrow'));
  const ezhou = rows.find(r => r.dataset.map === 'ezhou');
  if (!ezhou) return JSON.stringify({ err: 'NO-AOMEN-ROW' });
  (ezhou.querySelector('button')).click();
  await new Promise(r => setTimeout(r, 500));
  const okBtn = Array.from(document.querySelectorAll('.screen button, .card button')).find(b => (b.innerText || '').indexOf('开始经营') >= 0);
  if (!okBtn) return JSON.stringify({ err: 'NO-OK2', text: document.querySelector('.screen .card') ? document.querySelector('.screen .card').innerText.slice(0, 120) : '' });
  okBtn.click();
  const old = CM.game;
  for (let i = 0; i < 200 && (!CM.game || CM.game === old); i++) await new Promise(r => setTimeout(r, 100));
  const g = CM.game;
  for (let i = 0; i < 100 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 1500));
  const co = CM.Company.active();
  return JSON.stringify({ map: g.mapId, funds: Math.round(g.econ.funds), company: g.company || null,
    branches: co.branches.map(b => b.mapId), pool: co.pool,
    startFunds: CM.Company.startFundsFor('ezhou') });
})()`))
check('解锁后可从公司面板开始新城', started2.map === 'ezhou', started2)
check('新城仍带公司身份', !!(started2.company && started2.company.id), started2)
check('启动金 8 亿由市政府注入（池不扣）', started2.funds === 80000 && started2.pool === 155000, started2)
check('新城登记为第二分部', Array.isArray(started2.branches) && started2.branches.length === 2, started2)

// 5a-0. 鄂州阶段合同链：3~5 段，建到第 1 段目标 → 奖励发到本城现金
const chain = jp(await evalJs(`(async () => {
  const g = CM.game;
  if (!g || g.mapId !== 'ezhou') return JSON.stringify({ err: 'NOT-EZHOU' });
  const co = CM.Company.active();
  const cc = CM.Company.cityContractOf(co, 'ezhou');
  if (!cc || !cc.cur) return JSON.stringify({ err: 'NO-CHAIN', cc: cc });
  if (cc.stages.length < 3 || cc.stages.length > 5) return JSON.stringify({ err: 'BAD-LEN', n: cc.stages.length });
  const last = cc.stages[cc.stages.length - 1];
  if (last.goal !== 'sat' || last.months !== 2) return JSON.stringify({ err: 'BAD-TAIL', last: last });
  if (cc.stages[cc.stages.length - 2].goal !== 'stations' ||
      cc.stages[cc.stages.length - 2].target !== CM.Company.acceptNeed('ezhou')) {
    return JSON.stringify({ err: 'TAIL-NOT-ACCEPT', prev: cc.stages[cc.stages.length - 2] });
  }
  const M = CM.Metro, U0 = CM.U;
  const lineId = Object.keys(g.net.lines)[0];
  const need = cc.cur.target - Object.keys(g.net.stations).length;
  const er = g.edit((net) => {
    for (let k = 0; k < need; k++) {
      let near = null, nd = -1;
      for (const sid0 in net.stations) { const s = net.stations[sid0]; const d = U0.dist(64, 64, s.x, s.y); if (d > nd) { nd = d; near = sid0; } }
      const sid = M.addStation(net, 62 + k * 3, 60, { size: 'S', type: 'surface' }, g.city);
      const r = M.addSegment(net, lineId, near, sid, [], 'surface');
      if (r && r.error) throw new Error(r.error);
    }
  });
  if (er && er.error) return JSON.stringify({ err: 'EDIT ' + er.error });
  g.net = JSON.parse(JSON.stringify(g.draft.net)); g.draft = null;
  const funds0 = Math.round(g.econ.funds);
  const r = CM.Company.checkCityContract(g);
  return JSON.stringify({ stages: cc.stages.length, target: cc.cur.target, r: r,
    gained: Math.round(g.econ.funds) - funds0, idx: CM.Company.cityContractOf(CM.Company.get(co.id), 'ezhou').idx });
})()`))
check('鄂州阶段合同链为 3~5 段且末段是满意度', chain.stages >= 3 && !chain.err, chain)
check('末段站数目标等于验收线', !chain.err && chain.r !== undefined, chain)
check('建到第 1 段目标奖励发到本城现金', chain.r && chain.r.advanced === true &&
  chain.r.reward === chain.gained && chain.idx === 1, chain)

// 5a. B 分部推进两个月，A 分部必须真实补结算到同一公司月份
const settledA = jp(await evalJs(`(async () => {
  const co = CM.Company.active();
  const a = CM.Company.branchOf(co, 'wenzhou');
  const g = CM.game;
  if (!a || !a.slotId) return JSON.stringify({ err: 'NO-A-SLOT' });
  if (!g.startJump(2)) return JSON.stringify({ err: 'BUSY' });
  while (g.jumping) await new Promise(r => setTimeout(r, 100));
  let sawProgress = false, progressText = '';
  for (let i = 0; i < 600 && (CM.Company.settling || CM.Company._settleTimer); i++) {
    const el = document.querySelector('#settle-progress');
    if (el && !el.classList.contains('hidden')) { sawProgress = true; progressText = el.innerText.slice(0, 100); }
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 1500));
  const p = await CM.Save.load(a.slotId);
  const coNow = CM.Company.active();
  return JSON.stringify({ active: [g.clock.y, g.clock.m], a: [p.clock.y, p.clock.m],
    last: CM.Company.branchOf(coNow, 'wenzhou').lastRemit || null, campaign: CM.Company.campaignClock(coNow),
    progress: sawProgress, progressText: progressText, err: CM.Company.lastSettleError || null, settling: CM.Company.settling,
    slots: CM.Save.list('wenzhou')[0] ? CM.Save.list('wenzhou')[0].slots.map(s => ({ id: s.slotId, date: s.date, at: s.savedAt })) : [],
    slotId: a.slotId });
})()`))
check('其它分部在后台真实补结算', settledA.active[0] === settledA.a[0] && settledA.active[1] === settledA.a[1], settledA)
check('后台结算显示实时进度条', settledA.progress === true, settledA)

// 5b. 已有分部从选图页重开时，不能重新领难度标准 30 亿
const replay = jp(await evalJs(`(async () => {
  const old = CM.game;
  const expect = Math.round(CM.Company.branchOf(CM.Company.active(), 'ezhou').funds || 0);
  CM.newGame({ map: 'ezhou', mode: 'challenge', difficulty: 'normal', name: '重开核查' });
  for (let i = 0; i < 200 && (!CM.game || CM.game === old); i++) await new Promise(r => setTimeout(r, 100));
  const g = CM.game;
  for (let i = 0; i < 100 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 800));
  return JSON.stringify({ funds: Math.round(g.econ.funds), expect: expect, pool: CM.Company.poolOf(CM.Company.active()) });
})()`))
check('已有分部重开不会白拿 30 亿', replay.funds === replay.expect && replay.funds < 300000, replay)

// 6. 注资：人为把公司池补到 3 亿，紧急救援额度 2 亿
const injected = jp(await evalJs(`(async () => {
  const co = CM.Company.active();
  co.pool = 30000;
  CM.Company.save(co);
  CM.ui.openTop('company');
  await new Promise(r => setTimeout(r, 600));
  const btn = Array.from(document.querySelectorAll('.co-page button')).find(b => (b.innerText || '').indexOf('确认紧急救援') >= 0);
  const input = document.querySelector('.co-inject-input');
  if (!btn || !input) return JSON.stringify({ err: 'NO-RESCUE', btn: !!btn, input: !!input });
  input.value = '5000';
  btn.click();
  await new Promise(r => setTimeout(r, 500));
  const okBtn = Array.from(document.querySelectorAll('.screen button, .card button')).find(b => (b.innerText || '').indexOf('确认注资') >= 0);
  if (!okBtn) return JSON.stringify({ err: 'NO-OK3' });
  const g = CM.game, before = g.econ.funds;
  okBtn.click();
  await new Promise(r => setTimeout(r, 700));
  return JSON.stringify({ before: Math.round(before), after: Math.round(g.econ.funds),
    inject: g.econ.cur.inject || 0, pool: CM.Company.poolOf(CM.Company.active()) });
})()`))
check('自定义金额注资进入本地现金', injected.after === injected.before + 5000, injected)
check('注资写入账本 inject 科目', injected.inject === 5000, injected)
check('注资从公司池扣除', injected.pool === 25000, injected)

// 6b. 同一 12 个月内不能超过滚动剩余额度
const capAgain = jp(await evalJs(`(() => {
  const g = CM.game, co = CM.Company.active();
  const caps = CM.Company.injectCap(co, g.mapId, g.clock.y, g.clock.m);
  const r = CM.Company.inject(g, 16000, true);
  return JSON.stringify({ ok: r.ok, error: r.error, caps: caps });
})()`))
check('滚动注资上限不能反复触发', capAgain.ok === false, capAgain)

// 7. 刷新后公司、解锁与分部仍在
await boot()
const persist = jp(await evalJs(`(() => {
  const co = CM.Company.active();
  return JSON.stringify({ co: !!co, n: co ? co.branches.length : 0, unlocked: co && CM.Company.isUnlocked(co, 'ezhou'),
    pool: co ? co.pool : -1 });
})()`))
check('刷新后公司记录仍在', persist.co && persist.n === 2 && persist.pool === 25000, persist)
check('刷新后解锁状态仍在', persist.unlocked === true, persist)

// 7b. 公司记录导入：同 id 备份还原，且不打断当前局的 company 归属
const imported = jp(await evalJs(`(() => {
  const co = CM.Company.active();
  const beforeId = co.id;
  const data = { type: 'city-metro-company', version: 1, gameVersion: CM.CFG.GAME_VERSION,
    exportedAt: new Date().toISOString(), activeId: co.id, companies: [co] };
  const r = CM.Company.importData(JSON.stringify(data), { replace: true });
  const now = CM.Company.active();
  return JSON.stringify({ ok: r.ok, imported: r.imported, replaced: r.replaced,
    beforeId: beforeId, afterId: now.id, branches: now.branches.length, pool: now.pool });
})()`))
check('公司记录可以导入还原', imported.ok === true && imported.imported === 1 && imported.replaced === 1, imported)
check('导入不会改变当前局公司归属', imported.beforeId === imported.afterId && imported.branches === 2, imported)

// 8. 旧选图页兼容：局内打开后返回必须回到当前分部
const msel = jp(await evalJs(`(async () => {
  const latest = CM.Save.latest('ezhou');
  if (!latest) return JSON.stringify({ err: 'NO-EZHOU-SAVE' });
  await CM.Save.load(latest.slotId).then(p => CM.loadGame(p));
  for (let i = 0; i < 150 && (!CM.game || CM.game.mapId !== 'ezhou' || CM.game.pending); i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 500));
  const beforeMap = CM.game && CM.game.mapId;
  CM.ui.showMapSelect('ezhou');
  await new Promise(r => setTimeout(r, 800));
  const items = Array.from(document.querySelectorAll('.msel-item'));
  const ezhou = items.find(x => x.dataset.id === 'ezhou');
  const backBtn = document.querySelector('.msel-head .iconbtn');
  const tip = backBtn ? backBtn.getAttribute('data-tip') : '';
  if (backBtn) backBtn.click();
  await new Promise(r => setTimeout(r, 400));
  return JSON.stringify({ beforeMap: beforeMap, afterMap: CM.game && CM.game.mapId,
    locked: items.filter(x => x.classList.contains('locked')).length,
    ezhouLocked: ezhou ? ezhou.classList.contains('locked') : null,
    backTip: tip, screenHidden: document.getElementById('screen').classList.contains('hidden') });
})()`))
check('选图页仍有锁定地图', msel.locked > 0, msel)
check('已解锁的鄂州不再是锁定态', msel.ezhouLocked === false, msel)
check('旧选图页返回当前分部', msel.beforeMap === 'ezhou' && msel.afterMap === 'ezhou' &&
  msel.screenHidden === true && msel.backTip === '返回当前分部', msel)
check('全程 0 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3))

console.log('\\n' + pass + ' 通过 / ' + fail + ' 失败')
try { ws.close() } catch (e) {}
try { proc.kill() } catch (e) {}
process.exit(fail ? 1 : 0)
