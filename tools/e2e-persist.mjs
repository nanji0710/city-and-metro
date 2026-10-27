/**
 * 存档持久化端到端核查 —— 本作独有的四样东西到底进没进存档。
 *
 * 为什么非要开浏览器：人员名单、自定义运行图、难度档、公司自有资金，
 * 全是「活在内存里、面板上看得见」的东西。它们不发进存档的话，
 * 玩家刷新一次页面就白雇半天人、白排半天班，而且**不会报任何错**。
 * simcheck 那种 Node 侧断言测不到这一层，只有真刷新一次才知道。
 *
 * 断言（10 项，每一条都必须在刷新之后成立才有意义）：
 *   1. 广州挑战局能开起来且有线网
 *   2. 自定义高峰发车间隔能写进去（取 137 秒，既不是默认值也不是任何预设）
 *   3. 从人才市场雇到人
 *   4. 存盘成功
 *   5. 页面真刷新（内存对象全丢，不是软重启）
 *   6. 读回存档
 *   7. 自定义间隔仍是 137 秒
 *   8. 人员名单一个没少、还是同一个人
 *   9. 难度档没被重置
 *  10. 全程 0 console error
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9479
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-persist')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 自定义间隔。刻意取一个「不像任何默认值」的数：
 * 默认按线路算，预设按钮是 300/480 之类，137 撞不上，所以相等必然意味着真的存取到了。 */
const CUSTOM = 137

let pass = 0
let fail = 0
const ok = (name, extra) => { pass++; console.log('✓ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const no = (name, extra) => { fail++; console.log('✗ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const check = (name, cond, extra) => (cond ? ok(name, extra) : no(name, extra))
const jp = (s, fallback) => { try { return JSON.parse(s) } catch (e) { return fallback || {} } }

async function main() {
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
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {}
      consoleErrors.push((d.exception && d.exception.description) || d.text || 'unknown')
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '))
    }
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

  await send('Runtime.enable')
  await send('Page.enable')

  try {
    // ---------- 干净开局 ----------
    await send('Page.navigate', { url: BASE })
    await sleep(2400)
    // 清掉旧存档索引与公司记录，保证这一次是从零开始，不受上一轮 e2e 残留影响
    await evalJs(`(() => {
      try { localStorage.removeItem('cm1.companies'); } catch (e) {}
      try { localStorage.removeItem('cm1.companyActive'); } catch (e) {}
      // 持久化测试要直接开广州；用旧版全解锁公司绕过唯一入门图限制。
      if (CM.Company) {
        const seed = CM.Company.create('持久化旧公司', 'guangzhou');
        if (seed.ok) CM.Company.setActive(seed.company.id);
      }
      return 'CLEAN';
    })()`)

    // ---------- 1. 开局广州（挑战模式 · 标准难度） ----------
    const boot = jp(await evalJs(`(async () => {
      CM.newGame({ map: 'guangzhou', mode: 'challenge', difficulty: 'normal', name: '持久化核查' });
      for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
      const g = CM.game;
      for (let i = 0; i < 80 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
      try { CM.ui.closeScreen(); } catch (e) {}
      try { CM.ui.closePanel(true); } catch (e) {}
      if (g.speed > 0) CM.ui.setSpeed(0);
      // net.lines 是字典（键是 l1/l29/…），不是数组 —— 用 Object.values 取
      const lines = Object.values(g.net.lines || {});
      const line = lines[0];
      return JSON.stringify({
        map: g.mapId, diff: g.difficulty, lines: lines.length,
        lineId: line ? line.id : null,
        before: line ? CM.Ops.get(line).peakHeadwaySec : null,
        funds: Math.round(g.econ.funds),
      });
    })()`))
    check('广州挑战局开起来了且有线网', boot.map === 'guangzhou' && boot.lines > 0 && !!boot.lineId, boot)

    // ---------- 2. 写自定义间隔 ----------
    const setRes = jp(await evalJs(`(async () => {
      const g = CM.game;
      const find = (gg) => Object.values(gg.net.lines || {}).find(l => l.id === ${JSON.stringify(boot.lineId)});
      const line = find(g);
      if (!line) return JSON.stringify({ ok: false, why: '找不到那条线' });
      const r = CM.Ops.set(g, line.id, { peakHeadwaySec: ${CUSTOM} });
      const after = CM.Ops.get(find(CM.game)).peakHeadwaySec;
      return JSON.stringify({ after: after, res: r === undefined ? 'void' : r, ok: after === ${CUSTOM} });
    })()`))
    check('自定义高峰间隔已写入（' + CUSTOM + ' 秒）', setRes.ok === true, setRes)

    // ---------- 3. 雇一个人 ----------
    const hired = jp(await evalJs(`(async () => {
      const g = CM.game;
      const st = g.staff;
      if (!st) return JSON.stringify({ ok: false, why: '没有 staff 子系统' });
      if (!st.market.length) st.refreshMarket(CM.Staff.rngFor(g, g.clock.y, g.clock.m), g.clock.y, g.clock.m, 8);
      const c = st.market[0];
      if (!c) return JSON.stringify({ ok: false, why: '人才市场是空的' });
      const r = st.hire(c.id, null, g.econ);
      return JSON.stringify({
        ok: true, hire: r === undefined ? 'void' : r,
        count: st.hired.length,
        name: st.hired.length ? st.hired[st.hired.length - 1].name : null,
        role: st.hired.length ? st.hired[st.hired.length - 1].role : null,
      });
    })()`))
    check('从人才市场雇到人', hired.ok === true && hired.count >= 1 && !!hired.name, hired)

    // ---------- 4. 存盘 ----------
    const saved = jp(await evalJs(`(async () => {
      const g = CM.game;
      const r = await CM.Save.save(g, 'auto');
      // Save.list(map) 返回的是「若干局」，每局里有 slots[]，slotId 在 slots 里
      const games = CM.Save.list ? CM.Save.list('guangzhou') : null;
      const slot = games && games.length && games[0].slots ? games[0].slots[0] : null;
      return JSON.stringify({ ok: !!(r && r.ok), err: r && r.error,
        slotId: (r && r.slotId) || (slot && slot.slotId) || null,
        games: games ? games.length : -1 });
    })()`))
    check('存盘成功', saved.ok === true && !!saved.slotId, saved)

    // ---------- 5. 真刷新 ----------
    await send('Page.navigate', { url: BASE })
    await sleep(2600)
    const alive = await evalJs(`(() => JSON.stringify({ hasCM: !!(window.CM && CM.Save), hasGame: !!(window.CM && CM.game) }))()`)
    const av = jp(alive)
    check('页面已刷新，内存里的局已清空', av.hasCM === true && av.hasGame === false, av)

    // ---------- 6. 读回存档 ----------
    const back = jp(await evalJs(`(async () => {
      // 用存盘时拿到的 slotId 直接读，不靠 list 再猜一遍
      const slotId = ${JSON.stringify(saved.slotId)};
      const data = await CM.Save.load(slotId);
      CM.loadGame(data);
      for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
      const g = CM.game;
      for (let i = 0; i < 80 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
      if (g.speed > 0) try { CM.ui.setSpeed(0); } catch (e) {}
      const line = Object.values(g.net.lines || {}).find(l => l.id === ${JSON.stringify(boot.lineId)});
      return JSON.stringify({
        ok: true,
        map: g.mapId,
        headway: line ? CM.Ops.get(line).peakHeadwaySec : null,
        hiredCount: g.staff ? g.staff.hired.length : null,
        hiredName: g.staff && g.staff.hired.length ? g.staff.hired[g.staff.hired.length - 1].name : null,
        diff: g.difficulty,
        lines: Object.keys(g.net.lines || {}).length,
      });
    })()`))
    check('存档读回来了', back.ok === true && back.map === 'guangzhou', { ok: back.ok, map: back.map, why: back.why, lines: back.lines })

    // ---------- 7~9. 三样独有数据都还活着 ----------
    check('自定义发车间隔活着', back.headway === CUSTOM, { got: back.headway, want: CUSTOM })
    check('人员名单一个没少', back.hiredCount === hired.count && back.hiredName === hired.name,
      { got: back.hiredCount, want: hired.count, name: back.hiredName })
    check('难度档没被重置', back.diff === boot.diff, { got: back.diff, want: boot.diff })

    // ---------- 10. console ----------
    check('全程 0 console error  ' + JSON.stringify(consoleErrors.slice(0, 3)), consoleErrors.length === 0, consoleErrors.length)
  } finally {
    try { proc.kill() } catch (e) { /* ignore */ }
  }

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败' + (fail === 0 ? '。' : '。'))
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
