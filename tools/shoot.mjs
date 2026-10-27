/**
 * city-and-metro-vf 界面截图（Edge headless + CDP，零依赖）
 *
 * 用法：
 *   node tools/shoot.mjs <场景> [输出目录]
 *   BASE=http://127.0.0.1:4180/ node tools/shoot.mjs all tools/shots
 *
 * 场景：boot（开局页）/ game（进游戏后的地图）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = Number(process.env.PORT || 9401)
const BASE = process.env.BASE || 'http://127.0.0.1:4180/'
const OUT = process.argv[3] || 'tools/shots'

const SCENES = {
  boot: [['wait', 3000]],
  game: [
    ['wait', 3000],
    ['eval', `(() => {
      // 地图卡片：优先点「青湾」（教程，最简单、必定能进）
      const cards = [...document.querySelectorAll('[data-map], .map-card, .mcard, .card, button')];
      const pick = cards.find(e => (e.textContent || '').includes('青湾'))
        || cards.find(e => (e.textContent || '').includes('广州'));
      if (!pick) return 'MISS';
      pick.click();
      return 'OK:' + (pick.textContent || '').trim().slice(0, 30);
    })()`],
    ['wait', 2500],
    ['eval', `(() => {
      const btns = [...document.querySelectorAll('button, [role=button], .btn')];
      const go = btns.find(e => /开始|进入|开局|新局/.test(e.textContent || ''));
      if (!go) return 'MISS';
      go.click();
      return 'OK:' + (go.textContent || '').trim().slice(0, 30);
    })()`],
    ['wait', 6000],
  ],
  // 排班面板（本作独有）：直接开广州，然后调 UI 打开 ops 页。
  // 用 newGame 而不是点卡片 —— 点卡片只是选中，还要再点一次「开始」，多一步就多一个会漂的选择器。
  ops: [
    ['wait', 3000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.newGame) return 'NO-CM';
      window.CM.newGame({ map: 'guangzhou', mode: 'challenge', name: '排班试验局', difficulty: 'normal' });
      return 'NEWGAME';
    })()`],
    ['wait', 9000],
    ['eval', `(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const g = window.CM && window.CM.game;
        if (g && g.city && (g.city.roadGroups || []).length && !g.pending && !g.model.refreshing) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return 'READY';
    })()`],
    ['eval', `(() => {
      const g = window.CM && window.CM.game;
      if (!g) return 'NO-GAME';
      try { window.CM.ui.closeScreen(); } catch (e) {}
      try { window.CM.ui.closePanel(true); } catch (e) {}
      window.CM.ui.openTop('ops');
      return 'OPEN routes=' + ((g.compiled && g.compiled.routes) || []).length;
    })()`],
    ['wait', 1500],
    // 接管第一条线的排班，验证滑块与策略真的写进 net.lines[].ops
    ['eval', `(() => {
      const g = window.CM && window.CM.game;
      if (!g || !g.compiled || !g.compiled.routes.length) return 'NO-ROUTE';
      const rt = g.compiled.routes[0];
      const r = window.CM.Ops.set(g, rt.line.id, { peakHeadwaySec: 180, offHeadwaySec: 480, policy: 'peak_first' });
      window.CM.ui.rerenderPage();
      const o = window.CM.Ops.get(g.net.lines[rt.line.id]);
      return 'TAKEOVER ' + (r.ok ? 'ok' : 'fail') + ' ' + o.peakHeadwaySec + '/' + o.offHeadwaySec + '/' + o.policy;
    })()`],
    ['wait', 1200],
  ],
  // 公司面板（本作独有）：开一局 → 触发自动保存（登记分部）→ 打开公司页 → 看金库与可进驻城市
  company: [
    ['wait', 3000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.newGame) return 'NO-CM';
      if (!window.CM.MAPS.guangzhou) return 'NO-MAP';
      window.CM.newGame({ map: 'guangzhou', mode: 'challenge', name: '公司试验局', difficulty: 'normal' });
      return 'NEWGAME';
    })()`],
    ['wait', 9000],
    ['eval', `(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const g = window.CM && window.CM.game;
        if (g && g.city && (g.city.roadGroups || []).length && !g.pending && !g.model.refreshing) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return 'READY';
    })()`],
    // 触发一次自动保存，让 Company.onSaved 真的把这一局登记成分部
    ['eval', `(async () => {
      const g = window.CM && window.CM.game;
      if (!g) return 'NO-GAME';
      try { window.CM.ui.closeScreen(); } catch (e) {}
      try { window.CM.ui.closePanel(true); } catch (e) {}
      await window.CM.ui.doAutosave(true);
      const c = window.CM.Company && window.CM.Company.active();
      return 'SAVED company=' + (c ? c.name + '/' + c.branches.length : 'none') + ' gCompany=' + !!(g.company);
    })()`],
    ['wait', 800],
    ['eval', `(() => {
      window.CM.ui.openTop('company');
      return 'OPEN';
    })()`],
    ['wait', 1500],
  ],
  // 人员面板：进游戏后直接调 UI 打开（不依赖按钮文案，避免选择器漂移）
  // 人员面板（本作独有）：开一局真实城市而不是教程局 —— 教程局会盖上引导卡，
  // 截出来的图分不清哪块是面板。先用 newGame 直接开城，再雇三个人、把一个线长
  // 指派到 1 号线，最后才截「我的团队」，这样图里同时有线长在岗与待办提示。
  staff: [
    ['wait', 3000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.newGame) return 'NO-CM';
      if (!window.CM.MAPS.guangzhou) return 'NO-MAP';
      window.CM.newGame({ map: 'guangzhou', mode: 'challenge', name: '人员试验局', difficulty: 'normal' });
      return 'NEWGAME';
    })()`],
    ['wait', 9000],
    ['eval', `(async () => {
      // 城市是分帧生成的，等它真正落地再动人员，否则 g.net 还没有线可指派。
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const g = window.CM && window.CM.game;
        if (g && g.city && (g.city.roadGroups || []).length && !g.pending && !g.model.refreshing) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return 'READY';
    })()`],
    ['eval', `(() => {
      if (!window.CM || !window.CM.ui) return 'NO-UI';
      if (!window.CM.game) return 'NO-GAME';
      const g = window.CM.game;
      if (!g.staff) return 'NO-STAFF';
      // 雇三人：第一个线长挂到第一条线，其余留作城级加成。
      const lines = Object.keys(g.net.lines);
      const lineId = lines[0] || null;
      let n = 0;
      for (const c of g.staff.market.slice(0, 3)) {
        const r = g.staff.hire(c.id, n === 0 ? lineId : null, g.econ);
        if (r && r.ok) n++;
      }
      window.CM.ui.openTop('staff');
      return 'HIRED ' + n + ' / market=' + g.staff.market.length + ' hired=' + g.staff.hired.length + ' line=' + lineId;
    })()`],
    ['wait', 2200],
  ],
  // 地图选择页（54 城列表 + 地区筛选，年代筛选已移除）
  msel: [
    ['wait', 3000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.ui) return 'NO-UI';
      window.CM.ui.showMapSelect();
      return 'OPEN maps=' + (window.CM.MAP_ORDER || []).length;
    })()`],
    ['wait', 1800],
  ],
  // 直接开一局洛阳（不走点击，绕开选择器漂移；用来验证 54 城数据是否真能开局）
  luoyang: [
    ['wait', 3000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.newGame) return 'NO-CM';
      if (!window.CM.MAPS.luoyang) return 'NO-MAP:' + Object.keys(window.CM.MAPS).join(',');
      window.CM.newGame({ map: 'luoyang', mode: 'challenge', name: '洛阳试验局' });
      return 'NEWGAME';
    })()`],
    ['wait', 9000],
    // 生成城市是分帧跑的（city.generate → buildTerrain → buildRoadGroups 要栅格化上万条路），
    // 洛阳 120×72 格实测要十几秒。固定 9 秒会截到「正在生成 2025 年的洛阳」那一帧，
    // 所以轮询等它真正落地，而不是猜一个数字。
    ['eval', `(async () => {
      const t0 = Date.now();
      // 生成城市是分帧跑的（city.generate → buildTerrain → buildRoadGroups 要栅格化上万条路）。
      // 判据用 city.roadGroups —— city 上没有 roads 字段（那是 DATA.roads 的原始数据），
      // 一开始写错成 g.city.roads 导致条件永远为假、白等 30 秒还截到加载页。
      // 30 秒上限：CDP 的 Runtime.evaluate 本身有 40 秒超时，
      // 轮询比它更久的话，报的是 "Runtime.evaluate timeout" 而不是「城市没生成完」，看不出真因。
      while (Date.now() - t0 < 30000) {
        const g = window.CM && window.CM.game;
        if (g && g.city && (g.city.roadGroups || []).length && !g.pending && !g.model.refreshing) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return 'READY ' + Math.round((Date.now() - t0) / 100) / 10 + 's';
    })()`],
    ['eval', `(() => {
      const g = window.CM && window.CM.game;
      if (!g) return 'NO-GAME';
      // 关掉开局简报/任务面板，让画面回到地图
      try { window.CM.ui.closeScreen(); } catch (e) {}
      try { window.CM.ui.closePanel(true); } catch (e) {}
      return 'OK y=' + g.clock.y + ' stations=' + Object.keys(g.net.stations).length + ' lines=' + Object.keys(g.net.lines).length + ' pop=' + Math.round((g.city.pop || []).reduce((a, b) => a + b, 0)) + ' roads=' + (g.city.roadGroups || []).length;
    })()`],
    ['wait', 3000],
    // 加载页（#screen.loading）是 opacity 过渡 0.35s，但截图前 closeScreen 已经把它设成
    // opacity:0；真正盖住画面的是「开局简报」——start() 里 isNew 分支会立刻调
    // showBriefing(tip)，tip 里才 openPage('tasks')。所以截图前必须同时关简报。
    // 这里再显式确认一次：screen 的 opacity 归零、HUD 可见。
    ['eval', `(() => {
      try { window.CM.ui.closeScreen() } catch (e) {}
      const s = window.CM.ui.screen;
      return 'screenOpacity=' + getComputedStyle(s).opacity + ' cls=' + s.className;
    })()`],
    ['wait', 1200],
  ],
  // 难度档位（本作独有）：地图选择页右栏的开始区，四颗难度芯片
  diff: [
    ['wait', 3000],
    ['eval', `(() => { try { window.CM.ui.showMapSelect(); return 'OPEN'; } catch (e) { return 'ERR:' + e.message; } })()`],
    ['wait', 1000],
    ['eval', `(() => {
      const items = [...document.querySelectorAll('.msel-item')];
      const t = items.find(e => (e.textContent || '').includes('广州'));
      if (!t) return 'MISS';
      t.click();
      return 'PICK';
    })()`],
    ['wait', 900],
    ['eval', `(() => {
      const chips = [...document.querySelectorAll('.msel-diffchip')];
      const hard = chips.find(e => (e.textContent || '').includes('硬核'));
      if (hard) hard.click();
      return 'DIFF chips=' + chips.length + ' on=' + ((document.querySelector('.msel-diffchip.on') || {}).textContent || '');
    })()`],
    ['wait', 900],
  ],
  market: [
    ['wait', 3000],
    ['eval', `(() => {
      const cards = [...document.querySelectorAll('[data-map], .map-card, .mcard, .card, button')];
      const pick = cards.find(e => (e.textContent || '').includes('青湾'));
      if (pick) pick.click(); return 'CARD';
    })()`],
    ['wait', 2000],
    ['eval', `(() => {
      const btns = [...document.querySelectorAll('button, [role=button], .btn')];
      const go = btns.find(e => /^(开始|进入|开局|新局)/.test((e.textContent || '').trim()));
      if (go) { go.click(); return 'BTN'; } return 'NO-BTN';
    })()`],
    ['wait', 7000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.ui || !window.CM.game) return 'NO-GAME';
      window.CM.ui.openTop('staff');
      window.CM.ui.staffTab = 'market';
      const top = window.CM.ui.stack[window.CM.ui.stack.length - 1];
      if (top && top.kind === 'staff') top.id = 'market';
      window.CM.ui.renderPage(false);
      return 'MARKET cards=' + document.querySelectorAll('.ps-card').length;
    })()`],
    ['wait', 1800],
  ],
  // 突发事件（本作独有）：造一起待处置事故，截「人员面板 + 顶栏红点 + toast 动作」的完整现场。
  // 直接 newGame 而不是点卡片 —— 事故要靠真实车队，教程局没车不会出。
  incident: [
    ['wait', 3000],
    ['eval', `(async () => {
      if (!window.CM || !window.CM.newGame) return 'NO-CM';
      window.CM.newGame({ map: 'guangzhou', mode: 'challenge', difficulty: 'normal', name: '事故现场' });
      for (let i = 0; i < 150 && !window.CM.game; i++) await new Promise(r => setTimeout(r, 100));
      const g = window.CM.game;
      if (!g) return 'NO-GAME';
      for (let i = 0; i < 80 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
      return 'READY routes=' + ((g.compiled && g.compiled.routes) || []).length;
    })()`],
    ['wait', 800],
    ['eval', `(() => {
      const g = window.CM.game;
      if (!g || !g.compiled.routes.length) return 'NO-ROUTE';
      try { window.CM.ui.closeScreen(); } catch (e) {}
      try { window.CM.ui.closePanel(true); } catch (e) {}
      const rt = g.compiled.routes[0];
      const I = window.CM.Incidents;
      const mk = function (lv, id) {
        return { id: id, lv: lv.lv, key: lv.key, title: 'L' + lv.lv + ' · ' + lv.name + '（' + rt.line.name + '）',
          desc: lv.desc, routeId: rt.id, lineId: rt.lineId, lineName: rt.line.name,
          minutes: lv.minutes[1], satHit: lv.satHit, capLoss: lv.capLoss,
          cost: I.repairCostFor(lv, rt.stIdx.length, false), auto: false, handled: false, day: g.clock.d };
      };
      g.lastIncidents = [mk(I.LEVEL_BY_LV[3], 'shot_1'), mk(I.LEVEL_BY_LV[2], 'shot_2')];
      g.syncDisruptions();
      window.CM.ui.updateTop();
      window.CM.ui.openTop('staff');
      g.emit('toast', { kind: 'bad', text: 'L4 · 枢纽瘫痪 · 待处置', act: { label: '去处置', open: 'staff' } });
      return 'INC n=' + g.lastIncidents.length;
    })()`],
    ['wait', 1600],
  ],
  // 新手引导（本作扩展：基底 12 步 + 我们独有的雇人/排班/事故 3 步）
  // 直接 newGame({tutorial:true}) 跳过点卡片的漂移，然后跳到「雇一个人帮你」那一步截图。
  tutorial: [
    ['wait', 3000],
    ['eval', `(async () => {
      if (!window.CM || !window.CM.newGame) return 'NO-CM';
      window.CM.newGame({ map: 'wenzhou', mode: 'challenge', tutorial: true, name: '教程截图' });
      for (let i = 0; i < 150 && !window.CM.game; i++) await new Promise(r => setTimeout(r, 100));
      const g = window.CM.game;
      if (!g) return 'NO-GAME';
      for (let i = 0; i < 100 && (!g.city.roadGroups || !g.city.roadGroups.length || g.pending); i++) await new Promise(r => setTimeout(r, 200));
      try { window.CM.ui.closeScreen(); } catch (e) {}
      return 'READY coach=' + !!document.getElementById('coach');
    })()`],
    ['wait', 900],
    ['eval', `(() => {
      const g = window.CM.game;
      if (!g || !g.tutorial) return 'NO-TUT';
      // 直接跳到新增的三步之一：前面的 12 步要靠真实操作才能通过，截图不值得走一遍
      const coach = document.getElementById('coach');
      const total = document.querySelectorAll('.co-step').length;
      g.tutorial.step = 3;
      if (window.CM.Tutorial && window.CM.Tutorial.active()) {
        // 走内部 go() 才能刷新卡片与高亮：attach 一次相当于重建
        window.CM.Tutorial.detach();
        window.CM.Tutorial.attach(window.CM.ui, g);
      }
      const t = document.querySelector('.co-title');
      return 'STEP ' + (t ? t.textContent.trim() : 'none') + ' total=' + total;
    })()`],
    ['wait', 1600],
  ],
  // 更新公告：每次升版都要确认「版本号、标题、三条摘要」真的渲染出来了
  // （NEWS 是手写数据，少一个字段不会报错，只会静默少一行）
  news: [
    ['wait', 3000],
    ['eval', `(() => {
      try { window.CM.ui.showNews(); } catch (e) { return 'ERR:' + e.message; }
      const cur = document.querySelector('.news-v.cur');
      const t = document.querySelector('.news .sec-h .news-t');
      return 'NEWS v=' + (cur ? cur.textContent : 'none') + ' title=' + (t ? t.textContent : 'none')
        + ' items=' + document.querySelectorAll('.news-b li').length
        + ' ver=' + (window.CM.CFG ? window.CM.CFG.GAME_VERSION : '?');
    })()`],
    ['wait', 1500],
  ],
}

async function cdp(ws, method, params = {}) {
  const id = ++cdp.seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timeout`)), 40000)
    const h = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id === id) {
        clearTimeout(t)
        ws.removeEventListener('message', h)
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)
      }
    }
    ws.addEventListener('message', h)
  })
}
cdp.seq = 0

async function shoot(scene) {
  const proc = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1680,1050',
    'about:blank',
  ], { stdio: 'ignore' })

  let targets = null
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      targets = await r.json()
      if (targets.length) break
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  if (!targets?.length) throw new Error('CDP 未就绪')

  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })

  const errors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    }
  })

  await cdp(ws, 'Page.enable')
  await cdp(ws, 'Runtime.enable')
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false,
  })
  await cdp(ws, 'Page.navigate', { url: BASE })
  await sleep(2500)
  // 截图场景要能直接开任意城市；用旧版全解锁公司绕过战役入门图限制。
  await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => { try { const r = CM.Company.create('截图旧公司', 'guangzhou'); if (r.ok) CM.Company.setActive(r.company.id); } catch (e) {} return 'SEED'; })()`,
    returnByValue: true,
  })

  for (const [kind, arg] of SCENES[scene] ?? []) {
    if (kind === 'wait') { await sleep(arg); continue }
    if (kind === 'eval') {
      const r = await cdp(ws, 'Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true })
      console.log(`  eval -> ${JSON.stringify(r.result.value).slice(0, 400)}`)
      await sleep(1200)
    }
  }

  const probe = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => ({
      title: document.title,
      bodyLen: document.body.innerText.length,
      head: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
      hasCanvas: !!document.querySelector('canvas'),
      maps: (window.CM && window.CM.MAPS) ? Object.keys(window.CM.MAPS) : null,
      game: !!(window.CM && window.CM.game),
      frame: !!(window.CM && window.CM.R && window.CM.R.frame),
    }))()`,
    returnByValue: true,
  })
  console.log('  DOM:', JSON.stringify(probe.result.value).slice(0, 900))

  const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' })
  const file = `${OUT}/${scene}.png`
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log('  saved', file)

  if (errors.length) {
    console.log('  --- console errors ---')
    for (const e of errors.slice(0, 12)) console.log('    ' + String(e).slice(0, 400))
  } else {
    console.log('  no console errors')
  }

  ws.close()
  try { proc.kill() } catch { /* ignore */ }
}

mkdirSync(OUT, { recursive: true })
const arg = process.argv[2] || 'boot'
/*
 * 支持 `node tools/shoot.mjs <cityId> <outDir>`：任意城市直接开一局。
 *
 * 为什么需要：54 城是逐个抓进来的，每抓完一批都要确认「新进来的城真能开局」。
 * 只靠 luoyang 一个写死的场景，等于每次只验证那一个城市；
 * 而新城的格网尺寸、区域划分、片区名全是生成器现算的，出问题的概率恰恰最高。
 *
 * 命中已登记的场景名时走原逻辑，否则当成城市 id。
 */
const isScene = Object.prototype.hasOwnProperty.call(SCENES, arg) || arg === 'all'
if (!isScene) {
  const cityId = arg
  SCENES[cityId] = [
    ['wait', 3000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.newGame) return 'NO-CM';
      if (!window.CM.MAPS[${JSON.stringify(cityId)}]) return 'NO-MAP';
      window.CM.newGame({ map: ${JSON.stringify(cityId)}, mode: 'challenge', name: '试验局' });
      return 'NEWGAME';
    })()`],
    ['wait', 9000],
    ['eval', `(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const g = window.CM && window.CM.game;
        if (g && g.city && (g.city.roadGroups || []).length && !g.pending && !g.model.refreshing) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return 'READY ' + Math.round((Date.now() - t0) / 100) / 10 + 's';
    })()`],
    ['eval', `(() => {
      const g = window.CM && window.CM.game;
      if (!g) return 'NO-GAME';
      try { window.CM.ui.closeScreen(); } catch (e) {}
      try { window.CM.ui.closePanel(true); } catch (e) {}
      return 'OK y=' + g.clock.y + ' stations=' + Object.keys(g.net.stations).length + ' lines=' + Object.keys(g.net.lines).length + ' pop=' + Math.round((g.city.pop || []).reduce((a, b) => a + b, 0)) + ' roads=' + (g.city.roadGroups || []).length;
    })()`],
    ['wait', 3000],
  ]
}
const list = arg === 'all' ? Object.keys(SCENES) : [arg]
for (const s of list) {
  console.log(`== ${s} ==`)
  await shoot(s)
}
process.exit(0)
