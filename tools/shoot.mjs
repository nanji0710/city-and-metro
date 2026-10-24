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
  // 人员面板：进游戏后直接调 UI 打开（不依赖按钮文案，避免选择器漂移）
  staff: [
    ['wait', 3000],
    ['eval', `(() => {
      const cards = [...document.querySelectorAll('[data-map], .map-card, .mcard, .card, button')];
      const pick = cards.find(e => (e.textContent || '').includes('青湾'))
        || cards.find(e => (e.textContent || '').includes('广州'));
      if (!pick) return 'MISS-CARD';
      pick.click(); return 'CARD:' + (pick.textContent || '').trim().slice(0, 20);
    })()`],
    ['wait', 2000],
    ['eval', `(() => {
      // 地图卡片只是「选中」；真正开始是面板里的「开始」按钮或直接按 Enter
      const btns = [...document.querySelectorAll('button, [role=button], .btn')];
      const go = btns.find(e => /^(开始|进入|开局|新局)/.test((e.textContent || '').trim()));
      if (go) { go.click(); return 'BTN:' + (go.textContent || '').trim().slice(0, 20); }
      return 'NO-BTN';
    })()`],
    ['wait', 600],
    ['eval', `(() => {
      if (window.CM && window.CM.game) return 'ALREADY';
      // 兜底：面板里没有按钮时用 Enter（help 里写明「↑↓ 切换 · Enter 开始」）
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return 'ENTER';
    })()`],
    ['wait', 7000],
    ['eval', `(() => {
      if (!window.CM || !window.CM.ui) return 'NO-UI';
      if (!window.CM.game) return 'NO-GAME';
      window.CM.ui.openTop('staff');
      const g = window.CM.game;
      return 'OPENED staff=' + !!g.staff + ' market=' + (g.staff ? g.staff.market.length : 'x') + ' hired=' + (g.staff ? g.staff.hired.length : 'x');
    })()`],
    ['wait', 1800],
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
