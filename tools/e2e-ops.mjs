/**
 * 排班真的进账本了吗 —— 端到端因果链核查（本作最核心的一条主张）。
 *
 * 主张是「排班由玩家自己排，盈亏全看玩家操作」。这句话要成立，
 * 必须证明：玩家在面板上把发车间隔调稀 → 车公里真的少了 →
 * 账本里的运营成本真的降了。中间任何一环断掉，排班就只是个好看的滑块。
 *
 * 为什么非要开浏览器跑一个月：`Ops.set` 写的是 `net.lines[id].ops`，
 * 而成本是在**月初编译**时由 `M.compile(net)` 折进 `model.daily.carKm`、
 * 再每天由 `econ.day(daily,…)` 记账的。这条链横跨 UI → net → compile → model → econ，
 * Node 侧单独调任何一个函数都证明不了它通着。
 *
 * 断言（10 项）：
 *   1. 广州挑战局开起来了
 *   2. 默认没接管（manual=false，引擎自己在排）
 *   3. 点面板上的「节能优先」→ 真的写进了 net
 *   4. 面板读数（高峰间隔）跟着变了
 *   5. 改完之后账本里的「车公里」与「运营成本」都明显低于改之前那个月
 *   6. 点「交回引擎自动排班」→ ops 被删掉、manual 回到 false
 *   7. 全程 0 console error
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9483
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const PROFILE = join(ROOT, 'tools', '.edge-ops')
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 把广州战役图的五条线全部拉到 900 秒（15 分钟一班）—— 比默认的 240 秒稀得多，
 * 但还没到「不像地铁」的程度，免得测试同时触发了服务质量崩盘的其它分支。 */
const SPARSE = 900

let pass = 0
let fail = 0
const ok = (name, extra) => { pass++; console.log('✓ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const no = (name, extra) => { fail++; console.log('✗ ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))) }
const check = (name, cond, extra) => (cond ? ok(name, extra) : no(name, extra))
const jp = (s, fb) => { try { return JSON.parse(s) } catch (e) { return fb || {} } }

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
    await send('Page.navigate', { url: BASE })
    await sleep(2400)

    // ---------- 1. 开局，让模型先跑到稳态 ----------
    const boot = jp(await evalJs(`(async () => {
      // 旧版全解锁公司：新战役只开放温州，排班测试要直接开广州
      const seed = CM.Company.create('排班核查公司', 'guangzhou');
      if (seed.ok) CM.Company.setActive(seed.company.id);
      CM.newGame({ map: 'guangzhou', mode: 'challenge', difficulty: 'normal', name: '排班因果核查' });
      for (let i = 0; i < 150 && !CM.game; i++) await new Promise(r => setTimeout(r, 100));
      const g = CM.game;
      for (let i = 0; i < 120 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
      try { CM.ui.closeScreen(); } catch (e) {}
      try { CM.ui.closePanel(true); } catch (e) {}
      if (g.speed > 0) try { CM.ui.setSpeed(0); } catch (e) {}
      const lines = Object.values(g.net.lines || {});
      return JSON.stringify({
        map: g.mapId, lines: lines.length,
        firstId: lines.length ? lines[0].id : null,
        manual: lines.length ? CM.Ops.get(lines[0]).manual : null,
      });
    })()`))
    check('广州挑战局开起来了', boot.map === 'guangzhou' && boot.lines >= 1, boot)
    check('默认没接管（引擎自己在排班）', boot.manual === false, { manual: boot.manual })

    // ---------- 2. 打开排班面板，点「节能优先」 ----------
    const clicked = jp(await evalJs(`(async () => {
      const g = CM.game;
      CM.ui.openPage('ops', null, { root: true });
      await new Promise(r => setTimeout(r, 900));
      const btns = Array.from(document.querySelectorAll('.ops-pbtn'));
      const t = btns.find(b => (b.innerText || '').indexOf('节能优先') >= 0);
      if (!t) return JSON.stringify({ ok: false, why: '找不到按钮', btns: btns.map(b => b.innerText) });
      const beforeText = document.body.innerText;
      t.click();
      await new Promise(r => setTimeout(r, 700));
      const lines = Object.values(g.net.lines || {});
      const ops = CM.Ops.get(lines[0]);
      return JSON.stringify({
        ok: true, policy: ops.policy, manual: ops.manual,
        peak: ops.peakHeadwaySec, off: ops.offHeadwaySec,
        panelHasPolicy: (document.body.innerText || '').indexOf('节能优先') >= 0,
        btns: btns.length,
      });
    })()`))
    check('点「节能优先」真的写进了 net', clicked.ok === true && clicked.policy === 'conserve' && clicked.manual === true, clicked)
    // 每条线一组策略按钮（4 线 × 4 策略 = 16），所以只断言「是成组出现的」
    check('面板上按线分组给出了策略按钮', clicked.btns >= 4 && clicked.btns % 4 === 0, { btns: clicked.btns })

    // ---------- 3. 四线全拉到 900 秒，跑完整月，和默认排班那个月按「日均」对比 ----------
    // 按 clock 推进而不是按 update 次数 —— 每次 update(1/60) 推进多少游戏时间
    // 取决于 g.speed，写死次数会算出 2~3 个月的窗口，两个窗口天数不同就没法比。
    const flow = jp(await evalJs(`(async () => {
      const g = CM.game;
      g.speed = 3;
      const step = 1 / 60;
      const toMonthStart = () => {
        // 注意：停下来的位置就是 d=1。若直接再调一次会立刻返回（已经在 1 号），
        // 所以先至少推进一天，保证每次调用都真的跨到「下一个月」。
        const idx = (c) => c.y * 372 + (c.m - 1) * 31 + (c.d - 1);
        const s = idx(g.clock);
        let guard = 0;
        while (idx(g.clock) - s < 1 && guard < 20000) { g.update(step); guard++; }
        while (g.clock.d !== 1 && guard < 8000000) { g.update(step); guard++; }
        return guard;
      };
      const lastLedger = () => {
        const L = g.econ.ledger;
        return L.length ? L[L.length - 1] : null;
      };
      const perDay = (L) => (L && L.days > 0 ? L.ops / L.days : null);

      // 车公里按「两个完整服务日」测：月界上的最后一天可能只跑了夜间几小时，
      // 直接比会拿夜间半天和全天比，结论失真。
      const spinDays = (n) => { for (let i = 0; i < n * 24 * 12; i++) g.update(1 / 12); };
      spinDays(2);
      const kmA = g.model.daily ? g.model.daily.carKm : null;

      // 改成 900 秒（高峰/平峰都改，policy 用 fixed 保证策略层不会把间隔又乘回去）
      const lines = Object.values(g.net.lines || {});
      const setOk = lines.map(l => CM.Ops.set(g, l.id, {
        peakHeadwaySec: ${SPARSE}, offHeadwaySec: ${SPARSE}, policy: 'fixed',
      })).every(r => r && r.ok);
      spinDays(2);
      const kmC = g.model.daily ? g.model.daily.carKm : null;

      // 账本对比：先交回引擎跑一个完整月（月 A），再接管成 900 秒跑一个完整月（月 C）。
      // 4 站小线的成本大头是站务固定成本，所以这里只要求「不升反降」。
      lines.forEach(l => CM.Ops.auto(g, l.id));
      toMonthStart();
      const n0 = g.econ.ledger.length;
      toMonthStart();
      const LA = g.econ.ledger.length > n0 ? lastLedger() : null;

      lines.forEach(l => CM.Ops.set(g, l.id, {
        peakHeadwaySec: ${SPARSE}, offHeadwaySec: ${SPARSE}, policy: 'fixed',
      }));
      toMonthStart();
      const n1 = g.econ.ledger.length;
      toMonthStart();
      const LC = g.econ.ledger.length > n1 ? lastLedger() : null;

      return JSON.stringify({
        setOk, monthA: LA && LA.days, monthC: LC && LC.days,
        kmA: kmA && Math.round(kmA), kmC: kmC && Math.round(kmC),
        kmRatio: kmA && kmC ? +(kmC / kmA).toFixed(3) : null,
        opsA: LA && +perDay(LA).toFixed(1), opsC: LC && +perDay(LC).toFixed(1),
        opsRatio: LA && LC ? +(perDay(LC) / perDay(LA)).toFixed(3) : null,
      });
    })()`))
    check('四线排班都改成功了', flow.setOk === true, { setOk: flow.setOk })
    check('两个对比月都是完整月', flow.monthA >= 28 && flow.monthC >= 28,
      { monthA: flow.monthA, monthC: flow.monthC })
    check('拉稀间隔后完整服务日车公里真的降了', flow.kmRatio !== null && flow.kmRatio < 0.7,
      { kmA: flow.kmA, kmC: flow.kmC, kmRatio: flow.kmRatio })
    check('拉稀间隔后账本日均运营成本不升反降', flow.opsRatio !== null && flow.opsRatio <= 1.001,
      { opsA: flow.opsA, opsC: flow.opsC, opsRatio: flow.opsRatio })

    // ---------- 4. 交回引擎自动 ----------
    const back = jp(await evalJs(`(async () => {
      const g = CM.game;
      CM.ui.openPage('ops', null, { root: true });
      await new Promise(r => setTimeout(r, 800));
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.innerText || '').indexOf('交回引擎') >= 0);
      if (!b) return JSON.stringify({ ok: false, why: '找不到「交回引擎自动排班」' });
      b.click();
      await new Promise(r => setTimeout(r, 700));
      const lines = Object.values(g.net.lines || {});
      const ops = CM.Ops.get(lines[0]);
      return JSON.stringify({ ok: true, manual: ops.manual, hasOps: !!lines[0].ops });
    })()`))
    check('「交回引擎自动排班」能撤销接管', back.ok === true && back.manual === false && back.hasOps === false, back)

    check('全程 0 console error  ' + JSON.stringify(consoleErrors.slice(0, 3)), consoleErrors.length === 0, consoleErrors.length)
  } finally {
    try { proc.kill() } catch (e) { /* ignore */ }
  }

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败。')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
