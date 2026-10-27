'use strict';
/* 全国战略地图：只负责选城、解锁、进入，不加载任何城市本地底图。
 * 与城市经营层解耦：CM.game 仍然是当前城市，Atlas 打开时暂停当前城市。 */
(function (CM) {
  const U = CM.U, h = U.h, CO = function () { return CM.Company; };
  const ic = function (n, s) { return CM.icon(n, s); };
  const A = {
    isOpen: false, el: null, cv: null, ctx: null, card: null, head: null,
    game: null, prevSpeed: 0, speedSet: false, sel: null, hover: null,
    cam: { x: 0, y: 0, zoom: 1 }, base: 1, dpr: 1,
    hits: [], raf: 0, lastCard: 0, lastRender: 0, drag: null, last: null,
    filters: { q: '', province: 'all', status: 'all' }, filterBar: null, count: null,
  };
  const DATA = function () { return CM.CHINA_ATLAS || { cities: [], provinces: [] }; };
  const clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  const style = function (el, o) { Object.keys(o || {}).forEach(function (k) { el.style[k] = o[k]; }); return el; };

  // 经纬度 → 世界坐标；用中纬度 cos 避免中国东西向被拉宽太多。
  const KX = Math.cos(35 * Math.PI / 180);
  function project(lon, lat) { return { x: (lon - 104) * KX, y: (36 - lat) }; }
  function worldBox() {
    const pts = [];
    for (const p of DATA().provinces) for (const ring of p.rings) for (const q of ring) pts.push(project(q[0], q[1]));
    for (const c of DATA().cities) pts.push(project(c.lon, c.lat));
    if (!pts.length) return { minX: -4, maxX: 4, minY: -3, maxY: 3 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    return { minX, maxX, minY, maxY };
  }
  const BOX = worldBox();
  const CX = (BOX.minX + BOX.maxX) / 2, CY = (BOX.minY + BOX.maxY) / 2;
  const WW = BOX.maxX - BOX.minX, WH = BOX.maxY - BOX.minY;

  function mapScale() { return A.base * A.cam.zoom; }
  function toScreen(p) { return { x: (p.x - A.cam.x) * mapScale() + A.cv.clientWidth / 2, y: (p.y - A.cam.y) * mapScale() + A.cv.clientHeight / 2 }; }
  function toWorld(x, y) { const s = mapScale(); return { x: (x - A.cv.clientWidth / 2) / s + A.cam.x, y: (y - A.cv.clientHeight / 2) / s + A.cam.y }; }
  function clampCam() {
    const sx = mapScale(), vw = A.cv.clientWidth, vh = A.cv.clientHeight;
    const hw = vw / (2 * sx), hh = vh / (2 * sx);
    const pad = 0.02;
    if (WW + pad * 2 < hw * 2) A.cam.x = CX;
    else A.cam.x = clamp(A.cam.x, BOX.minX - pad + hw, BOX.maxX + pad - hw);
    if (WH + pad * 2 < hh * 2) A.cam.y = CY;
    else A.cam.y = clamp(A.cam.y, BOX.minY - pad + hh, BOX.maxY + pad - hh);
  }

  function cityMeta(id) { return CM.MAPS && CM.MAPS[id]; }
  function companyOf() { return CM.Company ? CM.Company.active() : null; }
  function branchOf(co, id) { return co && CM.Company ? CM.Company.branchOf(co, id) : null; }
  function unlocked(co, id) { return !co ? id === (CM.Company && CM.Company.STARTERS[0]) : CM.Company.isUnlocked(co, id); }
  function stateOf(id) {
    const co = companyOf(), b = branchOf(co, id);
    if (CM.game && CM.game.mapId === id) return b && b.failed ? 'failed' : 'current';
    if (!co) return id === (CM.Company && CM.Company.STARTERS[0]) ? 'starter' : 'locked';
    if (b) return b.failed ? 'failed' : 'owned';
    return unlocked(co, id) ? 'unlocked' : 'locked';
  }
  function statusText(id) {
    const s = stateOf(id);
    return s === 'current' ? '当前经营' : s === 'owned' ? '已进驻' : s === 'failed' ? '已停运' :
      s === 'unlocked' ? '已解锁' : s === 'starter' ? '新手城市' : '未解锁';
  }
  function statusColor(id) {
    const s = stateOf(id);
    return s === 'current' ? '#2fd1bf' : s === 'owned' ? '#4f8bff' : s === 'unlocked' ? '#7b8cff' :
      s === 'failed' ? '#ff5d6c' : s === 'starter' ? '#f5c451' : '#6f7c8c';
  }

  function resize() {
    if (!A.cv) return;
    A.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, hgt = window.innerHeight;
    A.cv.width = Math.round(w * A.dpr); A.cv.height = Math.round(hgt * A.dpr);
    style(A.cv, { width: w + 'px', height: hgt + 'px' });
    A.base = Math.min(w / (WW + 1.2), hgt / (WH + 1.2)) * 1.0;
    clampCam();
    render();
  }

  function drawPath(ctx, ring, sx, sy, scale) {
    if (!ring || ring.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const p = project(ring[i][0], ring[i][1]);
      const x = (p.x - A.cam.x) * scale + sx, y = (p.y - A.cam.y) * scale + sy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function clusters(list) {
    // 屏幕空间聚合；Wenzhou 始终单独显示，保证新手城市可见。
    const s = mapScale(), vw = A.cv.clientWidth, vh = A.cv.clientHeight;
    const pts = list.map(function (c, i) {
      const p = toScreen(project(c.lon, c.lat));
      return { c: c, i: i, x: p.x, y: p.y, vis: p.x > -40 && p.y > -40 && p.x < vw + 40 && p.y < vh + 40 };
    }).filter(function (p) { return p.vis; });
    if (A.cam.zoom >= 2.35) return pts.map(function (p) { return { kind: 'city', city: p.c, x: p.x, y: p.y }; });
    const parent = pts.map(function (_, i) { return i; });
    const find = function (x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const uni = function (a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const R = 26;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].c.id === 'wenzhou') continue;
      for (let j = i + 1; j < pts.length; j++) {
        if (pts[j].c.id === 'wenzhou') continue;
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        if (dx * dx + dy * dy <= R * R) uni(i, j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].c.id === 'wenzhou') continue;
      const k = find(i);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(pts[i]);
    }
    const out = [];
    for (const arr of groups.values()) {
      if (arr.length === 1) { const p = arr[0]; out.push({ kind: 'city', city: p.c, x: p.x, y: p.y }); }
      else {
        let x = 0, y = 0; for (const p of arr) { x += p.x; y += p.y; }
        out.push({ kind: 'cluster', cities: arr.map(function (p) { return p.c; }), x: x / arr.length, y: y / arr.length, n: arr.length });
      }
    }
    const w = pts.find(function (p) { return p.c.id === 'wenzhou'; });
    if (w) out.push({ kind: 'city', city: w.c, x: w.x, y: w.y });
    return out;
  }

  function visibleCities() {
    const q = (A.filters.q || '').trim().toLowerCase();
    return DATA().cities.filter(function (c) {
      const st = stateOf(c.id), mp = cityMeta(c.id) || {};
      if (A.filters.province !== 'all' && c.province !== A.filters.province) return false;
      if (A.filters.status !== 'all' && st !== A.filters.status) return false;
      if (!q) return true;
      const trait = mp.trait ? (mp.trait.name + ' ' + (mp.trait.fx || '')) : '';
      const anchors = mp.data && mp.data.anchors ? mp.data.anchors.map(function (a) { return a.name; }).join(' ') : '';
      return [c.name, c.id, c.province, trait, anchors].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  function render() {
    if (!A.cv || !A.ctx) return;
    const ctx = A.ctx, dpr = A.dpr, vw = A.cv.clientWidth, vh = A.cv.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    const g = ctx.createLinearGradient(0, 0, 0, vh);
    g.addColorStop(0, '#0f1825'); g.addColorStop(1, '#182334');
    ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
    // 经纬网
    ctx.strokeStyle = 'rgba(125,150,180,.08)'; ctx.lineWidth = 1;
    for (let lon = 75; lon <= 135; lon += 5) {
      const p = project(lon, 36), q = project(lon, 18);
      const a = toScreen(p), b = toScreen(q);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let lat = 20; lat <= 50; lat += 5) {
      const p = project(73, lat), q = project(135, lat);
      const a = toScreen(p), b = toScreen(q);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // 省级区：战略层只画轮廓和浅填充
    const sc = mapScale(), sx = vw / 2, sy = vh / 2;
    let pi = 0;
    for (const prov of DATA().provinces) {
      pi++;
      ctx.fillStyle = pi % 2 ? 'rgba(53,76,102,.62)' : 'rgba(47,68,92,.62)';
      ctx.strokeStyle = 'rgba(155,192,220,.36)'; ctx.lineWidth = 0.75;
      for (const ring of prov.rings) {
        drawPath(ctx, ring, sx, sy, sc);
        ctx.fill(); ctx.stroke();
      }
    }
    // 城市点 / 聚合
    A.hits = [];
    const list = visibleCities();
    if (A.count) A.count.textContent = list.length + ' / ' + DATA().cities.length + ' 城';
    for (const item of clusters(list)) {
      const isW = item.kind === 'city' && item.city.id === 'wenzhou';
      const selected = item.kind === 'city' && item.city.id === A.sel;
      if (item.kind === 'cluster') {
        ctx.beginPath(); ctx.arc(item.x, item.y, 13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(79,139,255,.9)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(item.n), item.x, item.y + 0.5);
        A.hits.push({ kind: 'cluster', x: item.x, y: item.y, r: 16, cities: item.cities });
        continue;
      }
      const c = item.city, s = stateOf(c.id), col = statusColor(c.id);
      if (selected || isW) {
        ctx.beginPath(); ctx.arc(item.x, item.y, selected ? 13 : 9, 0, Math.PI * 2);
        ctx.fillStyle = selected ? 'rgba(47,209,191,.18)' : 'rgba(245,196,81,.16)'; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(item.x, item.y, selected ? 5.5 : (s === 'locked' ? 3.2 : 4.2), 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = 'rgba(8,16,26,.9)'; ctx.lineWidth = 1.5; ctx.stroke();
      const showLabel = selected || isW || (A.cam.zoom >= 2.15) || s === 'current';
      if (showLabel) {
        ctx.fillStyle = selected ? '#d8fffb' : 'rgba(222,235,248,.9)'; ctx.font = (selected ? '600 12px' : '600 10px') + ' system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(c.name, item.x + 9, item.y);
      }
      A.hits.push({ kind: 'city', x: item.x, y: item.y, r: selected ? 16 : 11, id: c.id });
    }
  }

  /* ---------------- 城市卡片 ---------------- */
  function money(v) { return U.fmtMoney(v || 0); }
  function cardStatus(id) {
    const co = companyOf(), b = branchOf(co, id), st = stateOf(id), mp = cityMeta(id) || {};
    const fee = co ? CM.Company.unlockFee(id) : 0;
    const start = co ? CM.Company.startFundsFor(id) : 0;
    const current = CM.game && CM.game.mapId === id;
    const rows = [];
    rows.push(['状态', statusText(id)]);
    rows.push(['城市特性', mp.trait ? mp.trait.name : '普通城市']);
    if (mp.trait) rows.push(['效果', mp.trait.fx]);
    if (mp.data && mp.data.anchors && mp.data.anchors.length) rows.push(['真实锚点', mp.data.anchors.map(function (a) { return a.name; }).join(' · ')]);
    if (co) {
      rows.push(['公司池', money(CM.Company.poolOf(co))]);
      rows.push(['当前月份', (function () { const c = CM.Company.campaignClock(co); return c ? c.y + '年' + c.m + '月' : '—'; })()]);
    }
    if (b) {
      rows.push(['分部现金', money(b.funds)]);
      rows.push(['上次上缴', b.lastRemit ? b.lastRemit.y + '年' + b.lastRemit.m + '月 · ' + money(b.lastRemit.amount) : '—']);
    } else if (st === 'locked') {
      rows.push(['解锁费', money(fee)]);
      rows.push(['启动金', money(start)]);
      if (co) rows.push(['合计', money(fee + start)]);
    } else if (st === 'unlocked') {
      rows.push(['开城启动金', money(start)]);
    } else if (st === 'starter') {
      rows.push(['第一份合同', '新增 3 站 → 公司池 +7 亿']);
    }
    let button, tip, disabled = false;
    if (!co) {
      if (id === (CM.Company && CM.Company.STARTERS[0])) { button = '开始新手战役'; tip = '从温州开始，教程结束后进入全国地图'; }
      else { button = '先开始温州战役'; tip = '全公司只有温州是初始城市'; disabled = true; }
    } else if (current) { button = '返回当前城市'; tip = '关闭全国地图，继续经营当前城市'; }
    else if (st === 'current') { button = '返回城市'; }
    else if (b) { button = b.failed ? '读取存档' : '切换到这座城市'; tip = b.slotId ? '载入该分部存档' : '该分部还没有存档'; disabled = !b.slotId && !b.failed; }
    else if (st === 'unlocked') { button = '进入城市'; tip = '从公司池支付启动金 ' + money(start); disabled = (co.pool || 0) < start; }
    else { button = '解锁并进入'; tip = '解锁 ' + money(fee) + ' + 启动金 ' + money(start); disabled = (co.pool || 0) < fee + start; }
    return { rows, button, tip, disabled, start, fee, b, co, current };
  }

  function updateCard() {
    if (!A.card) return;
    if (!A.sel) { A.card.classList.add('hidden'); return; }
    const id = A.sel, c = DATA().cities.find(function (x) { return x.id === id; });
    if (!c) return;
    const st = cardStatus(id);
    A.card.innerHTML = '';
    const close = h('button', { class: 'iconbtn', 'aria-label': '关闭城市卡片', onclick: function () { A.sel = null; A.updateCard(); } }, ic('close'));
    A.card.append(h('div', { class: 'atlas-card-h' },
      h('div', { class: 'grow' }, h('b', null, c.name), h('div', { class: 'tiny muted' }, (c.province || '') + ' · ' + statusText(id))), close));
    const kv = h('div', { class: 'atlas-kv' });
    for (const r of st.rows) kv.appendChild(h('div', null, h('span', null, r[0]), h('b', null, r[1])));
    A.card.appendChild(kv);
    A.card.appendChild(h('div', { class: 'atlas-card-actions' },
      h('button', {
        class: 'btn primary sm', disabled: st.disabled ? true : null, 'data-tip': st.tip,
        onclick: function () { if (!st.disabled) A.enter(id); },
      }, st.button, ic('chev', 14)),
      h('button', {
        class: 'btn sm ghost', onclick: function () { A.centerCity(id, 3.2); },
      }, '定位')));
    A.card.classList.remove('hidden');
  }

  function updateHead() {
    if (!A.head) return;
    const co = companyOf();
    const g = CM.game;
    const date = g ? (g.clock.y + '年' + g.clock.m + '月') :
      (co && CM.Company.campaignClock(co) ? (function (c) { return c.y + '年' + c.m + '月'; })(CM.Company.campaignClock(co)) : '—');
    A.head.innerHTML = '';
    A.head.append(
      h('div', { class: 'atlas-title' }, h('b', null, '全国战略地图'), h('span', { class: 'tiny muted' }, co ? '公司池 ' + money(CM.Company.poolOf(co)) + ' · ' + date : '从温州开始你的城轨公司')),
      h('div', { class: 'grow' }),
      h('div', { class: 'atlas-speed' },
        ['暂停', '1×', '3×', '8×'].map(function (t, i) {
          return h('button', {
            class: 'atlas-sp' + (g && g.speed === i ? ' on' : ''),
            disabled: !g,
            onclick: function () { if (!g) return; A.speedSet = true; CM.ui.setSpeed(i); A.updateHead(); },
          }, t);
        })),
      h('button', { class: 'atlas-hbtn', onclick: function () { A.reset(); } }, '全国', ic('expand', 14)),
      h('button', { class: 'iconbtn', 'aria-label': '关闭全国地图', onclick: function () { A.close(); } }, ic('close')));
  }


  function makeFilterBar() {
    const provinces = Array.from(new Set(DATA().cities.map(function (c) { return c.province; })))
      .sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
    const input = h('input', {
      class: 'atlas-search', type: 'search', placeholder: '搜索城市 / 特性 / 锚点', value: A.filters.q,
      oninput: function () { A.filters.q = input.value; if (A.sel && !visibleCities().some(function (c) { return c.id === A.sel; })) { A.sel = null; updateCard(); } render(); },
    });
    // 阻止搜索框里的 +/-/方向键传给全国图快捷键。
    input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); const list = visibleCities(); if (list.length) { A.sel = list[0].id; updateCard(); centerCity(list[0].id, 3.2); } } });
    const sel = h('select', { class: 'atlas-select', 'aria-label': '按省份筛选', onchange: function () { A.filters.province = sel.value; if (A.sel && !visibleCities().some(function (c) { return c.id === A.sel; })) { A.sel = null; updateCard(); } render(); } },
      h('option', { value: 'all' }, '全部省份'),
      provinces.map(function (p) { return h('option', { value: p, selected: A.filters.province === p ? true : null }, p); }));
    const states = [['all', '全部状态'], ['current', '当前经营'], ['owned', '已进驻'], ['unlocked', '已解锁'], ['failed', '已停运'], ['starter', '新手城市'], ['locked', '未解锁']];
    const st = h('select', { class: 'atlas-select', 'aria-label': '按状态筛选', onchange: function () { A.filters.status = st.value; if (A.sel && !visibleCities().some(function (c) { return c.id === A.sel; })) { A.sel = null; updateCard(); } render(); } },
      states.map(function (x) { return h('option', { value: x[0], selected: A.filters.status === x[0] ? true : null }, x[1]); }));
    A.count = h('span', { class: 'atlas-count' }, '');
    return h('div', { class: 'atlas-filter' },
      input, sel, st,
      h('button', {
        class: 'atlas-hbtn', onclick: function () {
          const id = (CM.game && CM.game.mapId) || (CM.Company && CM.Company.STARTERS[0]);
          if (!id) return;
          A.sel = id; updateCard(); centerCity(id, 3.2);
        },
      }, '定位当前'), A.count);
  }

  function centerCity(id, z) {
    const c = DATA().cities.find(function (x) { return x.id === id; }); if (!c) return;
    A.cam.x = project(c.lon, c.lat).x; A.cam.y = project(c.lon, c.lat).y;
    A.cam.zoom = z || Math.max(2.4, A.cam.zoom); clampCam(); render();
  }
  function zoomAt(x, y, factor) {
    const before = toWorld(x, y);
    A.cam.zoom = clamp(A.cam.zoom * factor, 1, 8);
    const after = toWorld(x, y);
    A.cam.x += before.x - after.x; A.cam.y += before.y - after.y;
    clampCam(); render();
  }
  function reset() { A.cam.zoom = 1; A.cam.x = CX; A.cam.y = CY; clampCam(); render(); }

  function selectAt(x, y) {
    let best = null, bd = 22;
    for (const hit of A.hits) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= Math.max(hit.r || 12, 10) && d < bd) { bd = d; best = hit; }
    }
    if (!best) { A.sel = null; A.updateCard(); return; }
    if (best.kind === 'cluster') { A.cam.x = toWorld(best.x, best.y).x; A.cam.y = toWorld(best.x, best.y).y; A.cam.zoom = Math.min(3.2, A.cam.zoom * 1.8); clampCam(); render(); return; }
    A.sel = best.id; A.updateCard(); render();
  }

  function bind() {
    const cv = A.cv;
    const onDown = function (e) {
      if (e.button != null && e.button !== 0) return;
      A.drag = { x: e.clientX, y: e.clientY, cx: A.cam.x, cy: A.cam.y, moved: 0 };
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
    };
    const onMove = function (e) {
      if (!A.drag) { A.hover = { x: e.clientX, y: e.clientY }; return; }
      const dx = e.clientX - A.drag.x, dy = e.clientY - A.drag.y;
      A.drag.moved = Math.max(A.drag.moved, Math.abs(dx) + Math.abs(dy));
      if (A.drag.moved > 4) {
        A.cam.x = A.drag.cx - dx / mapScale(); A.cam.y = A.drag.cy - dy / mapScale();
        clampCam(); render();
      }
    };
    const onUp = function (e) {
      if (!A.drag) return;
      const d = A.drag; A.drag = null;
      if (d.moved <= 4) selectAt(e.clientX, e.clientY);
    };
    const onWheel = function (e) {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0014);
      zoomAt(e.clientX, e.clientY, f);
    };
    const onKey = function (e) {
      if (e.key === 'Escape') { if (A.sel) { A.sel = null; A.updateCard(); render(); } else A.close(); return; }
      if (e.key === '+' || e.key === '=') { zoomAt(innerWidth / 2, innerHeight / 2, 1.25); e.preventDefault(); }
      if (e.key === '-' || e.key === '_') { zoomAt(innerWidth / 2, innerHeight / 2, 0.8); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { A.cam.x -= 0.4 / A.cam.zoom; clampCam(); render(); }
      if (e.key === 'ArrowRight') { A.cam.x += 0.4 / A.cam.zoom; clampCam(); render(); }
      if (e.key === 'ArrowUp') { A.cam.y -= 0.4 / A.cam.zoom; clampCam(); render(); }
      if (e.key === 'ArrowDown') { A.cam.y += 0.4 / A.cam.zoom; clampCam(); render(); }
    };
    const onResize = function () { resize(); };
    A._unbind = function () {
      cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp); cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize);
    };
    cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false }); window.addEventListener('keydown', onKey); window.addEventListener('resize', onResize);
  }

  A.open = function (opts) {
    if (A.isOpen) return;
    opts = opts || {};
    A.isOpen = true; A.speedSet = false;
    A.game = CM.game || null;
    A.prevSpeed = A.game ? (A.game.speed || 0) : 0;
    if (A.game && A.game.speed > 0 && CM.ui) CM.ui.setSpeed(0);
    A.sel = opts.select || (A.game ? A.game.mapId : (CM.Company && CM.Company.STARTERS[0])) || null;
    A.cam = A.last || { x: CX, y: CY, zoom: 1 };
    const cv = h('canvas', { class: 'atlas-canvas' });
    A.cv = cv; A.ctx = cv.getContext('2d');
    A.head = h('div', { class: 'atlas-head' });
    A.filterBar = makeFilterBar();
    A.card = h('div', { class: 'atlas-card hidden' });
    const hint = h('div', { class: 'atlas-hint' }, '拖动平移 · 滚轮缩放 · 点击城市 · Enter 选中搜索结果');
    A.el = h('div', { id: 'atlas' }, cv, A.head, A.filterBar, A.card, hint);
    document.body.appendChild(A.el);
    document.body.classList.add('atlas-open');
    resize(); bind(); updateHead(); updateCard();
    const loop = function (t) {
      if (!A.isOpen) return;
      if (t - A.lastCard > 500) { A.lastCard = t; updateHead(); if (A.sel) updateCard(); }
      if (t - A.lastRender > 500) { A.lastRender = t; render(); }
      A.raf = requestAnimationFrame(loop);
    };
    A.raf = requestAnimationFrame(loop);
    if (opts.focus) centerCity(opts.focus, opts.zoom || 2.4);
  };

  A.close = function () {
    if (!A.isOpen) return;
    A.isOpen = false;
    if (A.raf) cancelAnimationFrame(A.raf);
    if (A._unbind) A._unbind();
    if (A.el) A.el.remove();
    document.body.classList.remove('atlas-open');
    A.last = { x: A.cam.x, y: A.cam.y, zoom: A.cam.zoom };
    const g = A.game;
    if (g && g.speed === 0 && A.prevSpeed > 0 && !A.speedSet && g.setSpeed) g.setSpeed(A.prevSpeed);
    A.el = null; A.cv = null; A.ctx = null; A.head = null; A.card = null; A.filterBar = null; A.count = null;
  };

  A._toast = function (t, k) {
    if (!A.el) { if (CM.ui && CM.ui.toast) CM.ui.toast(t, k || 'info'); return; }
    const el = h('div', { class: 'atlas-toast ' + (k || 'info') }, t);
    A.el.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
  };
  A._prepare = function (fn) {
    // 从公司面板直接开城时 Atlas 并没有打开，此时必须保存 CM.game 而不是 A.game。
    const g = A.game || CM.game;
    if (g && CM.ui) CM.ui.setSpeed(0);
    const p = (g && CM.ui && CM.ui.doAutosave && !CM.ui.isSaved()) ? CM.ui.doAutosave(true) : Promise.resolve({ ok: true });
    return p.then(function (r) { if (r && r.ok === false) { A._toast('当前进度保存失败，未切换城市', 'bad'); return; } A.close(); fn(); });
  };

  A._newBranch = function (id) {
    const co = companyOf(); if (!co) return A._toast('还没有公司', 'warn');
    const mp = cityMeta(id) || {}, start = CM.Company.startFundsFor(id);
    const fee = CM.Company.isUnlocked(co, id) ? 0 : CM.Company.unlockFee(id);
    const need = fee + start;
    if ((co.pool || 0) < need) {
      return A._toast('公司池不足：解锁 + 启动金共需 ' + money(need) + '（可用 ' + money(co.pool || 0) + '）', 'warn');
    }
    // 先预加载底图；底图失败时不扣池、不登记分部。
    const preload = CM.loadGeo ? CM.loadGeo(id) : Promise.resolve();
    preload.then(function () {
      A._prepare(function () {
        CM.newGame({
          map: id, mode: 'challenge',
          difficulty: CM.Difficulty ? CM.Difficulty.DEFAULT_KEY : 'normal',
          name: '经营挑战 · ' + (mp.name || id),
          company: { id: co.id, name: co.name }, startFunds: start, companyBranch: true, atlasTx: true,
          onStart: function (g) {
            // 城市已经创建成功；现在才扣公司池并登记分部。
            const r = CM.Company.openBranch(co, id, { startFunds: start });
            if (!r.ok) {
              if (CM.ui) CM.ui.toast(r.error || '开城失败', 'bad');
              CM.endGame();
              throw new Error(r.error || '开城失败');
            }
          },
        });
      });
    }, function (e) {
      A._toast('底图加载失败：' + (e && e.message || e), 'bad');
    });
  };

  A._enter = function (id) {
    const co = companyOf(), b = branchOf(co, id), st = stateOf(id);
    if (!co) {
      if (id !== (CM.Company && CM.Company.STARTERS[0])) { A.sel = CM.Company.STARTERS[0]; A.updateCard(); return A._toast('先开始温州新手战役', 'warn'); }
      return A._prepare(function () {
        CM.newGame({ map: id, mode: 'challenge', difficulty: 'easy', name: '温州 · 新手战役', tutorial: true });
      });
    }
    if (CM.game && CM.game.mapId === id) { A.close(); return; }
    if (b) {
      if (b.slotId) {
        A._prepare(function () {
          if (CM.ui) CM.ui.showLoading('正在载入 ' + ((cityMeta(id) || {}).name || id) + '…');
          CM.Save.load(b.slotId).then(function (p) { CM.loadGame(p); }).catch(function (e) {
            if (CM.ui) CM.ui.closeScreen && CM.ui.closeScreen();
            A._toast('载入分部失败：' + (e && e.message || e), 'bad');
          });
        });
      } else {
        A._prepare(function () {
          CM.newGame({ map: id, mode: 'challenge', difficulty: CM.Difficulty ? CM.Difficulty.DEFAULT_KEY : 'normal',
            name: '经营挑战 · ' + (b.name || id), company: { id: co.id, name: co.name }, startFunds: Math.max(0, b.funds || 0), companyBranch: true });
        });
      }
      return;
    }
    if (st === 'unlocked') return A._newBranch(id);
    const fee = CM.Company.unlockFee(id), start = CM.Company.startFundsFor(id);
    if ((co.pool || 0) < fee + start) return A._toast('公司池不足：解锁 + 启动金共需 ' + money(fee + start) + '（可用 ' + money(co.pool || 0) + '）', 'warn');
    // 解锁和开城合并为一次事务：城市创建成功后才扣费/登记。
    A._newBranch(id);
  };

  A._warp = function (id, done) {
    const c = DATA().cities.find(function (x) { return x.id === id; });
    if (!c || !A.el) { done(); return; }
    const p = toScreen(project(c.lon, c.lat));
    const w = h('div', { class: 'atlas-warp' });
    w.style.left = p.x + 'px'; w.style.top = p.y + 'px';
    A.el.appendChild(w);
    requestAnimationFrame(function () { w.classList.add('on'); });
    setTimeout(function () { if (w.parentNode) w.parentNode.removeChild(w); done(); }, 460);
  };

  A.enter = function (id) {
    if (A._busy) return;
    if (CM.game && CM.game.mapId === id) { A._enter(id); return; }
    A._busy = true;
    A._warp(id, function () { A._busy = false; A._enter(id); });
  };

  A.updateCard = updateCard;
  A.updateHead = updateHead;
  A.render = render;
  A.resize = resize;
  A.zoomAt = zoomAt;
  A.centerCity = centerCity;
  CM.Atlas = A;
})(window.CM);
