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
  function isDarkTheme() { return document.documentElement.dataset.theme === 'dark'; }

  function mapTheme() {
    const dark = isDarkTheme();
    return {
      dark: dark,
      bg0: dark ? '#111a28' : '#f5f8fc',
      bg1: dark ? '#1d2a3d' : '#e8eff7',
      glow: dark ? 'rgba(106,166,230,.10)' : 'rgba(47,111,168,.07)',
      grid: dark ? 'rgba(154,181,212,.08)' : 'rgba(43,84,128,.08)',
      landA: dark ? 'rgba(47,70,101,.90)' : 'rgba(227,239,249,.94)',
      landB: dark ? 'rgba(37,56,83,.88)' : 'rgba(208,226,241,.94)',
      line: dark ? 'rgba(154,181,212,.38)' : 'rgba(43,84,128,.28)',
      coast: dark ? 'rgba(196,220,246,.62)' : 'rgba(27,54,92,.38)',
      label: dark ? 'rgba(229,236,246,.88)' : 'rgba(23,38,61,.80)',
      selectedLabel: dark ? '#d9fff9' : '#0f5a53',
      cluster: dark ? 'rgba(106,166,230,.94)' : 'rgba(47,111,168,.94)',
      clusterText: '#fff',
      pointStroke: dark ? 'rgba(9,16,27,.92)' : 'rgba(255,255,255,.94)',
    };
  }

  // 状态色板：地图点、图例、筛选菜单共用一套，浅色/深色各一组。
  const STATUS_COLORS = {
    current: ['#188a7c', '#3fc1b0'],
    owned: ['#2f6fa8', '#6aa6e6'],
    unlocked: ['#7367ee', '#9d92ff'],
    failed: ['#d83a3a', '#ff7070'],
    starter: ['#d99a00', '#f0b33c'],
    locked: ['#98a6b8', '#66768e'],
  };
  function statusColorOf(s, dark) {
    const c = STATUS_COLORS[s] || STATUS_COLORS.locked;
    return (dark == null ? isDarkTheme() : dark) ? c[1] : c[0];
  }
  function statusColor(id) { return statusColorOf(stateOf(id), isDarkTheme()); }

  /* 顶栏同一时间只留一个浮层：搜索建议和两个下拉互相排斥，避免面板叠在一起 */
  const popClosers = [];
  function closePops(keep) {
    popClosers.forEach(function (fn) { if (fn !== keep) { try { fn(); } catch (e) { /* 已销毁 */ } } });
  }
  function unpop(fn) {
    const i = popClosers.indexOf(fn);
    if (i >= 0) popClosers.splice(i, 1);
  }

  function statusClass(id) { return 'st-' + stateOf(id); }

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

  // 城市是否命中一组筛选条件。抽出来是为了让下拉菜单能算「换到这一项会剩几座城」。
  function matchCity(c, f) {
    const st = stateOf(c.id), mp = cityMeta(c.id) || {};
    if (f.province !== 'all' && c.province !== f.province) return false;
    if (f.status !== 'all' && st !== f.status) return false;
    const q = (f.q || '').trim().toLowerCase();
    if (!q) return true;
    const trait = mp.trait ? (mp.trait.name + ' ' + (mp.trait.fx || '')) : '';
    const anchors = mp.data && mp.data.anchors ? mp.data.anchors.map(function (a) { return a.name; }).join(' ') : '';
    return [c.name, c.id, c.province, trait, anchors].join(' ').toLowerCase().indexOf(q) >= 0;
  }
  function visibleCities() {
    return DATA().cities.filter(function (c) { return matchCity(c, A.filters); });
  }
  function countWith(over) {
    const f = { q: A.filters.q, province: A.filters.province, status: A.filters.status };
    for (const k in over) f[k] = over[k];
    return DATA().cities.filter(function (c) { return matchCity(c, f); }).length;
  }
  // 搜索结果：前缀命中优先，其次短名优先，避免「广州」被「广州南」之类挤走。
  function searchMatches(limit) {
    const q = (A.filters.q || '').trim().toLowerCase();
    if (!q) return [];
    return visibleCities().slice().sort(function (a, b) {
      const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      const ap = an.indexOf(q) === 0 ? 0 : 1, bp = bn.indexOf(q) === 0 ? 0 : 1;
      return ap - bp || an.length - bn.length || an.localeCompare(bn, 'zh-Hans-CN');
    }).slice(0, limit);
  }
  function paintCount(n) {
    if (!A.count || A.count._n === n) return;
    A.count._n = n;
    A.count.textContent = '';
    A.count.append(h('b', null, String(n)), h('span', null, '/ ' + DATA().cities.length + ' 城'));
  }

  function render() {
    if (!A.cv || !A.ctx) return;
    const ctx = A.ctx, dpr = A.dpr, vw = A.cv.clientWidth, vh = A.cv.clientHeight;
    const T = mapTheme();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    const g = ctx.createLinearGradient(0, 0, 0, vh);
    g.addColorStop(0, T.bg0); g.addColorStop(1, T.bg1);
    ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
    // 主题一致的环境光，让地图不是一块孤立的深蓝画布。
    const glow = ctx.createRadialGradient(vw * .72, vh * .22, 0, vw * .72, vh * .22, Math.max(vw, vh) * .72);
    glow.addColorStop(0, T.glow); glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, vw, vh);
    // 经纬网
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    for (let lon = 75; lon <= 135; lon += 5) {
      const a = toScreen(project(lon, 36)), b = toScreen(project(lon, 18));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let lat = 20; lat <= 50; lat += 5) {
      const a = toScreen(project(73, lat)), b = toScreen(project(135, lat));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // 省级区：浅色下是纸面地图，深色下是指挥台底图。
    const sc = mapScale(), sx = vw / 2, sy = vh / 2;
    let pi = 0;
    ctx.lineJoin = 'round';
    for (const prov of DATA().provinces) {
      pi++;
      ctx.fillStyle = pi % 2 ? T.landA : T.landB;
      for (const ring of prov.rings) {
        drawPath(ctx, ring, sx, sy, sc);
        ctx.fill(); ctx.strokeStyle = T.line; ctx.lineWidth = .8; ctx.stroke();
      }
    }
    // 海岸轮廓略强，让中国轮廓在浅色主题里也能立住。
    ctx.strokeStyle = T.coast; ctx.lineWidth = 1.15;
    for (const prov of DATA().provinces) for (const ring of prov.rings) { drawPath(ctx, ring, sx, sy, sc); ctx.stroke(); }
    // 城市点 / 聚合
    A.hits = [];
    const labels = [];
    const list = visibleCities();
    if (A.count) paintCount(list.length);
    for (const item of clusters(list)) {
      const isW = item.kind === 'city' && item.city.id === 'wenzhou';
      const selected = item.kind === 'city' && item.city.id === A.sel;
      if (item.kind === 'cluster') {
        ctx.beginPath(); ctx.arc(item.x, item.y, 21, 0, Math.PI * 2);
        ctx.fillStyle = isDarkTheme() ? 'rgba(106,166,230,.10)' : 'rgba(47,111,168,.09)'; ctx.fill();
        ctx.beginPath(); ctx.arc(item.x, item.y, 13, 0, Math.PI * 2);
        ctx.fillStyle = T.cluster; ctx.fill();
        ctx.strokeStyle = T.pointStroke; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.fillStyle = T.clusterText; ctx.font = '650 10px ' + (CM.CFG.font || 'system-ui, sans-serif');
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(item.n), item.x, item.y + .5);
        A.hits.push({ kind: 'cluster', x: item.x, y: item.y, r: 16, cities: item.cities });
        continue;
      }
      const c = item.city, s = stateOf(c.id), col = statusColor(c.id);
      if (selected || isW) {
        ctx.beginPath(); ctx.arc(item.x, item.y, selected ? 17 : 13, 0, Math.PI * 2);
        ctx.fillStyle = selected
          ? (isDarkTheme() ? 'rgba(63,193,176,.20)' : 'rgba(42,157,143,.16)')
          : (isDarkTheme() ? 'rgba(240,179,60,.16)' : 'rgba(217,154,0,.12)');
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(item.x, item.y, selected ? 8 : (s === 'locked' ? 3.8 : 5), 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = T.pointStroke; ctx.lineWidth = selected ? 2 : 1.4; ctx.stroke();
      if (selected) {
        ctx.beginPath(); ctx.arc(item.x, item.y, 12, 0, Math.PI * 2);
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
      }
      const showLabel = selected || isW || (A.cam.zoom >= 2.15) || s === 'current';
      if (showLabel) {
        labels.push({
          text: c.name, x: item.x + 10, y: item.y, selected: selected,
          pr: selected ? 3 : ((isW || s === 'current') ? 2 : 1),
        });
      }
      A.hits.push({ kind: 'city', x: item.x, y: item.y, r: selected ? 18 : 12, id: c.id });
    }
    /* 标签避让：先放选中的城市，再放温州/当前经营，最后才是普通城市。
     * 任何一个标签与已放置的标签相交就跳过 —— 长三角、珠三角放大后
     * 城市名会挤在一起，宁可少显示几个，也不能叠成一团。 */
    labels.sort(function (a, b) { return b.pr - a.pr; });
    const placed = [];
    for (const L of labels) {
      ctx.font = (L.selected ? '700 12px' : '600 10px') + ' ' + (CM.CFG.font || 'system-ui, sans-serif');
      const tw = ctx.measureText(L.text).width;
      const box = { x: L.x - 2, y: L.y - 7, w: tw + 4, h: 14 };
      let clash = false;
      for (const p of placed) {
        if (!(box.x + box.w <= p.x || p.x + p.w <= box.x || box.y + box.h <= p.y || p.y + p.h <= box.y)) { clash = true; break; }
      }
      if (clash) continue;
      placed.push(box);
      ctx.fillStyle = L.selected ? T.selectedLabel : T.label;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(L.text, L.x, L.y);
    }
    A.labelBoxes = placed;   // 供布局回归检查「标签不重叠」
  }

  /* ---------------- 城市卡片 ---------------- */
  function money(v) { return U.fmtMoney(v || 0); }
  function cardStatus(id) {
    const co = companyOf(), b = branchOf(co, id), st = stateOf(id), mp = cityMeta(id) || {};
    // 已解锁的城市再进城由市政府注入启动金；只有 locked 才把开通费算进成本。
    const fee = co && st === 'locked' ? CM.Company.unlockFee(id) : 0;
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
    // 当前局的实时覆盖率优先于月度快照（只有正在玩的那座城市有实时值）
    const liveFor = function (mapId) {
      const g = CM.game;
      const d = g && g.mapId === mapId && g.model && g.model.daily;
      return d && d.ready && typeof d.coverage === 'number' ? d.coverage : null;
    };
    const gNow = CM.game;
    if (b) {
      rows.push(['分部现金', money(b.funds)]);
      rows.push(['上次上缴', b.lastRemit ? b.lastRemit.y + '年' + b.lastRemit.m + '月 · ' + money(b.lastRemit.amount) : '—']);
      const acc = CM.Company.acceptState(co, id, liveFor(id));
      rows.push(['覆盖', acc.current != null ? U.fmtPct(acc.current, 1) : '—']);
      rows.push(['解锁门槛', '≥ ' + U.fmtPct(acc.threshold, 0) + (CM.Company.isStarter(id) ? '（入门城）' : '') + ' · ' + (acc.reachable ? '已达标' : '未达标')]);
      if (acc.usedBy) rows.push(['解锁', '已用于解锁「' + ((CM.MAPS[acc.usedBy] || {}).name || acc.usedBy) + '」']);
      else if (acc.reachable) rows.push(['启动金加成', '+' + money(acc.bonus) + '（' + U.fmtPct(CM.Company.UNLOCK_COVER, 0) + ' 起每 +2% 加 1 亿）']);
    } else if (st === 'locked') {
      rows.push(['开通费', money(fee)]);
      const src = co ? CM.Company.pickUnlockSource(co, { sourceMapId: gNow && gNow.mapId, sourceCover: liveFor(gNow && gNow.mapId) }) : null;
      const seed = start + (src ? src.bonus : 0);
      rows.push(['启动金', money(seed) + (src && src.bonus > 0 ? '（基础 ' + money(start) + ' + 加成 ' + money(src.bonus) + '）' : '（市政府资本金）')]);
      const srcs = co ? CM.Company.unlockSources(co) : [];
      let best = srcs[0] || null;
      if (best) { const lv = liveFor(best.mapId); if (lv != null) best = Object.assign({}, best, { cover: lv }); }
      if (co) rows.push(['解锁条件', '任一分部达到覆盖率门槛（入门城 ' + U.fmtPct(CM.Company.STARTER_UNLOCK_COVER, 0) +
        '，其余 ' + U.fmtPct(CM.Company.UNLOCK_COVER, 0) + '）' +
        (best ? '（最高「' + ((CM.MAPS[best.mapId] || {}).name || best.mapId) + '」' + U.fmtPct(best.cover, 1) + '）' : '（暂无分部达标）')]);
    } else if (st === 'unlocked') {
      rows.push(['开城启动金', money(CM.Company.seedFor(co, id)) + '（解锁时已结算）']);
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
    else if (st === 'unlocked') { button = '进入城市'; tip = '启动金 ' + money(CM.Company.seedFor(co, id)) + ' 已在解锁时结算，由市政府资本金注入'; }
    else {
      const src = CM.Company.pickUnlockSource(co, { sourceMapId: gNow && gNow.mapId, sourceCover: liveFor(gNow && gNow.mapId) });
      if (!src) {
        button = '解锁并进入';
        tip = '解锁资格不足：需要一座分部覆盖率 ≥ ' + U.fmtPct(threshold, 0) + '（在已进驻城市里把线网建到 70% 以上）';
        disabled = true;
      } else if ((co.pool || 0) < fee) {
        button = '解锁并进入'; tip = '公司池不足开通费 ' + money(fee) + '（可用 ' + money(co.pool || 0) + '）'; disabled = true;
      } else {
        const seed = start + src.bonus;
        button = '解锁并进入';
        tip = '用「' + ((CM.MAPS[src.mapId] || {}).name || src.mapId) + '」' + U.fmtPct(src.cover, 1) +
          ' 覆盖率解锁：开通费 ' + money(fee) + '，启动金 ' + money(seed) +
          '（基础 ' + money(start) + (src.bonus > 0 ? ' + 加成 ' + money(src.bonus) : '') + '）；解锁后再涨覆盖率不会改变这次启动金';
      }
    }
    return { rows, button, tip, disabled, start, fee, b, co, current };
  }

  function updateCard() {
    if (!A.card) return;
    if (!A.sel) { A.card.classList.add('hidden'); return; }
    const id = A.sel, c = DATA().cities.find(function (x) { return x.id === id; });
    if (!c) return;
    const st = cardStatus(id), mp = cityMeta(id) || {};
    /* 内容没变就不重建：卡片每 500ms 会被刷新一次，重建会把手动滚动的位置顶回顶部，
     * 矮屏上玩家刚往下滚就跳回去，看起来像内容重叠/抖动。 */
    const sig = [id, st.button, st.tip, st.disabled ? 1 : 0, JSON.stringify(st.rows),
      st.b && st.b.lastRemit ? [st.b.lastRemit.y, st.b.lastRemit.m, st.b.lastRemit.amount].join(':') : ''].join('|');
    const wasHidden = A.card.classList.contains('hidden');
    if (!wasHidden && A.cardSig === sig) return;
    A.cardSig = sig;
    A.card.innerHTML = '';
    const close = h('button', { class: 'iconbtn sm', 'aria-label': '关闭城市卡片', onclick: function () { A.sel = null; A.updateCard(); } }, ic('close'));
    A.card.append(h('div', { class: 'atlas-card-h' },
      h('div', { class: 'atlas-card-title' },
        h('span', { class: 'atlas-status ' + statusClass(id) }, statusText(id)),
        h('b', null, c.name),
        h('small', null, c.province || '')),
      close));
    const body = h('div', { class: 'atlas-card-body' });
    // 正文可滚动时给底部加渐隐，避免内容在半行处被硬切断（看起来像重叠）
    const syncFade = function () {
      body.classList.toggle('more', body.scrollHeight - body.scrollTop - body.clientHeight > 4);
    };
    body.addEventListener('scroll', syncFade);
    setTimeout(syncFade, 0);
    const tags = h('div', { class: 'atlas-tags' });
    if (mp.trait) tags.append(h('span', { class: 'atlas-tag trait' }, mp.trait.name));
    if (mp.data && mp.data.anchors) mp.data.anchors.forEach(function (a) { tags.append(h('span', { class: 'atlas-tag anchor' }, a.name)); });
    if (tags.children.length) body.appendChild(tags);
    const kv = h('div', { class: 'atlas-kv' });
    st.rows.forEach(function (r) { kv.appendChild(h('div', null, h('span', null, r[0]), h('b', null, String(r[1])))); });
    body.appendChild(kv);
    if (st.b && st.b.lastRemit) {
      body.appendChild(h('div', { class: 'atlas-note' },
        '上次真实月结：' + st.b.lastRemit.y + '年' + st.b.lastRemit.m + '月'));
    }
    A.card.appendChild(body);
    // 开城成本固定放在滚动区外：矮屏上不会被正文的滚动边界裁掉半行
    if (!st.b && (st.fee || st.start)) {
      A.card.appendChild(h('div', { class: 'atlas-cost' },
        h('span', null, '开城成本'), h('b', null, money(st.fee + st.start))));
    }
    A.card.appendChild(h('div', { class: 'atlas-card-actions' },
      h('button', {
        class: 'btn primary sm fill', disabled: st.disabled ? true : null, 'data-tip': st.tip,
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
    const clock = co ? CM.Company.campaignClock(co) : null;
    const date = g ? (g.clock.y + '年' + g.clock.m + '月') : (clock ? clock.y + '年' + clock.m + '月' : '—');
    A.head.innerHTML = '';
    A.head.append(
      h('div', { class: 'atlas-brand' },
        h('span', { class: 'atlas-brand-ico' }, ic('globe', 17)),
        h('div', { class: 'atlas-title' },
          h('b', null, '全国战略地图'),
          h('span', null, co ? co.name : '从温州开始你的城轨公司'))),
      h('div', { class: 'atlas-stats' },
        h('div', { class: 'atlas-stat' }, h('span', null, '公司池'), h('b', null, co ? money(CM.Company.poolOf(co)) : '—')),
        h('div', { class: 'atlas-stat' }, h('span', null, '月份'), h('b', null, date)),
        h('div', { class: 'atlas-stat' }, h('span', null, '分部'), h('b', null, co ? co.branches.length + ' 城' : '—'))));
    if (A.speedBtns) {
      A.speedBtns.forEach(function (b, i) {
        b.classList.toggle('on', !!g && g.speed === i);
        b.disabled = !g;
      });
    }
  }


  /* ---------------- 筛选控件 ---------------- */
  /* 自绘下拉：原生 <select> 的选项面板由系统绘制，深色主题里是一块突兀的白，
     也显示不了状态色与数量。这里整套重做，键盘 / 鼠标 / 触屏行为全部收在页面内。 */
  function makeDropdown(o) {
    const lb = h('span', { class: 'atlas-dd-lb' });
    const menu = h('div', { class: 'atlas-dd-menu', role: 'listbox', 'aria-label': o.aria });
    const root = h('div', {
      class: 'atlas-dd' + (o.align === 'end' ? ' end' : ''), role: 'button', tabindex: '0',
      'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': o.aria,
    }, lb, h('span', { class: 'atlas-dd-chev' }, ic('chev', 15)), menu);
    let isOpen = false, active = 0, items = [];

    function paint() {
      const cur = o.options().filter(function (x) { return x.v === o.get(); })[0];
      lb.textContent = cur ? cur.label : o.aria;
      root.classList.toggle('filtered', o.get() !== 'all');
    }
    function build() {
      menu.textContent = ''; items = []; active = 0;
      o.options().forEach(function (x, i) {
        const el = h('button', {
          class: 'atlas-opt' + (x.v === o.get() ? ' sel' : ''), type: 'button',
          role: 'option', 'aria-selected': x.v === o.get() ? 'true' : 'false',
          onclick: function () { pick(i); },
          onpointerdown: function (e) { e.preventDefault(); },   // 保住焦点，避免 focusout 先一步关掉面板
          onpointerenter: function () { setActive(i, false); },
        },
          x.color ? h('i', { class: 'atlas-opt-dot', style: { background: x.color } }) : null,
          h('span', { class: 'atlas-opt-t' }, x.label),
          x.count == null ? null : h('span', { class: 'atlas-opt-n' }, String(x.count)),
          h('span', { class: 'atlas-opt-ck' }, ic('check', 13)));
        items.push(el); menu.appendChild(el);
      });
    }
    function setActive(i, scroll) {
      if (!items.length) return;
      active = (i + items.length) % items.length;
      items.forEach(function (el, k) { el.classList.toggle('on', k === active); });
      if (scroll) items[active].scrollIntoView({ block: 'nearest' });
    }
    function show() {
      if (isOpen) return;
      closePops(hide);
      build();
      isOpen = true;
      root.classList.add('open');
      root.setAttribute('aria-expanded', 'true');
      const cur = o.options().map(function (x) { return x.v; }).indexOf(o.get());
      setActive(cur < 0 ? 0 : cur, true);
    }
    function hide() {
      if (!isOpen) return;
      isOpen = false;
      root.classList.remove('open');
      root.setAttribute('aria-expanded', 'false');
      items.forEach(function (el) { el.classList.remove('on'); });
    }
    function pick(i) {
      const x = o.options()[i];
      if (!x) return;
      hide(); o.onPick(x.v); paint(); root.focus();
    }

    root.addEventListener('click', function (e) {
      if (e.target.closest('.atlas-opt')) return;   // 选项自己的 click 已经处理
      if (isOpen) hide(); else show();
    });
    root.addEventListener('keydown', function (e) {
      const k = e.key;
      e.stopPropagation();   // 全国图的方向键平移 / Esc 关图不能吃掉下拉里的按键
      if (k === 'Escape') { e.preventDefault(); hide(); return; }
      if (k === 'Tab') { hide(); return; }
      if (!isOpen) {
        if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') {
          e.preventDefault(); show();
          if (k === 'ArrowUp') setActive(active - 1, true);
        }
        return;
      }
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); setActive(active + (k === 'ArrowDown' ? 1 : -1), true); return; }
      if (k === 'Home' || k === 'End') { e.preventDefault(); setActive(k === 'Home' ? 0 : items.length - 1, true); return; }
      if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(active); }
    });
    root.addEventListener('focusout', function (e) {
      if (!root.contains(e.relatedTarget)) hide();
    });
    popClosers.push(hide);
    paint();
    return { root: root, sync: paint, dispose: function () { unpop(hide); hide(); } };
  }

  /* 搜索框：图标 + 内联清除 + 快捷键提示，聚焦后给出可键盘选择的城市建议。 */
  function makeSearch() {
    const input = h('input', {
      class: 'atlas-search-in', type: 'search', placeholder: '搜索城市 / 特性 / 锚点',
      value: A.filters.q || '', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-label': '搜索城市', 'aria-autocomplete': 'list',
      'aria-controls': 'atlas-sug', 'aria-expanded': 'false',
    });
    const clear = h('button', {
      class: 'atlas-clear', type: 'button', 'aria-label': '清除搜索', tabindex: '-1',
      onpointerdown: function (e) { e.preventDefault(); },
      onclick: function () { input.value = ''; onInput(); input.focus(); },
    }, ic('close', 14));
    const root = h('div', { class: 'atlas-search' },
      h('span', { class: 'atlas-search-ico' }, ic('search', 16)), input, clear,
      h('kbd', { class: 'atlas-kbd', 'aria-hidden': 'true' }, '/'));
    const sug = h('div', { class: 'atlas-sug', id: 'atlas-sug', role: 'listbox', 'aria-label': '搜索结果' });
    let items = [], active = -1;
    syncChrome();   // 上次关闭时保留的筛选词也要让清除按钮 / kbd 提示对上

    function syncChrome() { root.classList.toggle('has-q', !!input.value.trim()); }
    function closeSug() {
      sug.classList.remove('open');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      items = []; active = -1;
    }
    function setActive(i, scroll) {
      if (!items.length) { active = -1; return; }
      active = (i + items.length) % items.length;
      items.forEach(function (el, k) { el.classList.toggle('on', k === active); });
      input.setAttribute('aria-activedescendant', items[active].id);
      if (scroll) items[active].scrollIntoView({ block: 'nearest' });
    }
    function choose(id) {
      A.sel = id; updateCard(); centerCity(id, 3.2);
      closeSug();
    }
    function refresh() {
      sug.textContent = ''; items = []; active = -1;
      if (document.activeElement !== input) { closeSug(); return; }
      closePops(closeSug);
      const q = (A.filters.q || '').trim();
      if (!q) {
        // 聚焦但还没输入：说明能搜什么，而不是弹一块空面板。
        sug.appendChild(h('div', { class: 'atlas-sug-head' }, '搜索城市 / 特性 / 城市锚点'));
        sug.appendChild(h('div', { class: 'atlas-sug-hint' },
          '当前筛选下共 ' + visibleCities().length + ' 座城市。输入关键词后可用 ↑↓ 选择，Enter 定位。'));
        sug.classList.add('open');
        input.setAttribute('aria-expanded', 'true');
        return;
      }
      const total = visibleCities().length, list = searchMatches(8);
      if (!list.length) {
        sug.appendChild(h('div', { class: 'atlas-sug-empty' },
          h('b', null, '没有匹配「' + q + '」的城市'),
          h('span', null, '换个关键词，或把省份 / 状态筛选放宽')));
        sug.classList.add('open');
        input.setAttribute('aria-expanded', 'true');
        return;
      }
      sug.appendChild(h('div', { class: 'atlas-sug-head' },
        '匹配 ' + total + ' 座城市', h('span', null, '↑↓ 选择 · Enter 定位')));
      list.forEach(function (c, i) {
        const mp = cityMeta(c.id) || {}, col = statusColor(c.id);
        const el = h('button', {
          class: 'atlas-sug-item', type: 'button', role: 'option', id: 'atlas-sug-' + i,
          'data-id': c.id, 'aria-selected': 'false',
          onpointerdown: function (e) { e.preventDefault(); },
          onclick: function () { choose(c.id); input.focus(); },
          onpointerenter: function () { setActive(i, false); },
        },
          h('i', { class: 'atlas-sug-dot', style: { background: col } }),
          h('span', { class: 'atlas-sug-name' }, c.name),
          h('span', { class: 'atlas-sug-meta' },
            [c.province, mp.trait ? mp.trait.name : ''].filter(Boolean).join(' · ')),
          h('span', { class: 'atlas-sug-st', style: { color: col } }, statusText(c.id)));
        items.push(el); sug.appendChild(el);
      });
      sug.classList.add('open');
      input.setAttribute('aria-expanded', 'true');
    }

    function onInput() {
      A.filters.q = input.value;
      syncChrome();
      refresh();
      if (A.sel && !visibleCities().some(function (c) { return c.id === A.sel; })) { A.sel = null; updateCard(); }
      render();
    }

    input.addEventListener('input', onInput);
    input.addEventListener('focus', refresh);
    input.addEventListener('click', function () { if (!sug.classList.contains('open')) refresh(); });
    input.addEventListener('focusout', function (e) {
      if (!root.contains(e.relatedTarget)) closeSug();
    });
    input.addEventListener('keydown', function (e) {
      // 输入框里的方向键 / ± / Esc 不能传给全国图快捷键。
      e.stopPropagation();
      const k = e.key, open = sug.classList.contains('open');
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        if (!open) { refresh(); if (items.length) setActive(k === 'ArrowDown' ? 0 : items.length - 1, true); return; }
        const next = active < 0 ? (k === 'ArrowDown' ? 0 : items.length - 1)
          : active + (k === 'ArrowDown' ? 1 : -1);
        setActive(next, true);
        return;
      }
      if (k === 'Enter') {
        e.preventDefault();
        if (!(A.filters.q || '').trim()) return;
        let id = (active >= 0 && items[active]) ? items[active].getAttribute('data-id') : null;
        if (!id) { const one = searchMatches(1); id = one.length ? one[0].id : null; }
        if (id) choose(id);
        return;
      }
      if (k === 'Escape') {
        if (open) { e.preventDefault(); closeSug(); return; }
        if (input.value) { e.preventDefault(); input.value = ''; onInput(); }
        return;
      }
      if (k === 'Tab') closeSug();
    });

    syncChrome();
    popClosers.push(closeSug);
    return { root: root, input: input, sug: sug, dispose: function () { unpop(closeSug); closeSug(); } };
  }

  function makeFilterBar() {
    const provinces = Array.from(new Set(DATA().cities.map(function (c) { return c.province; })))
      .sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
    const states = [['all', '全部状态'], ['current', '当前经营'], ['owned', '已进驻'], ['unlocked', '已解锁'], ['failed', '已停运'], ['starter', '新手城市'], ['locked', '未解锁']];
    const search = makeSearch();
    A.search = search.input;

    function applyFilter() {
      if (A.sel && !visibleCities().some(function (c) { return c.id === A.sel; })) { A.sel = null; updateCard(); }
      render();
    }
    const provDD = makeDropdown({
      aria: '按省份筛选', align: '', get: function () { return A.filters.province; },
      options: function () {
        return [{ v: 'all', label: '全部省份', count: countWith({ province: 'all' }) }]
          .concat(provinces.map(function (p) { return { v: p, label: p, count: countWith({ province: p }) }; }));
      },
      onPick: function (v) { A.filters.province = v; applyFilter(); },
    });
    const statDD = makeDropdown({
      aria: '按状态筛选', align: 'end', get: function () { return A.filters.status; },
      options: function () {
        return states.map(function (x) {
          return {
            v: x[0], label: x[1], count: countWith({ status: x[0] }),
            color: x[0] === 'all' ? null : statusColorOf(x[0]),
          };
        });
      },
      onPick: function (v) { A.filters.status = v; applyFilter(); },
    });
    A.count = h('span', { class: 'atlas-count', title: '当前筛选命中的城市 / 全国城市总数' });
    A.pops = A.pops || [];
    A.pops.push(search.dispose, provDD.dispose, statDD.dispose);
    // 计数跟在下拉后面，靠右的剩余空间由它吃掉，窄屏时也不会把控件挤成两行。
    return h('div', { class: 'atlas-filter', role: 'search' },
      search.root, provDD.root, statDD.root, A.count, search.sug);
  }

  function locateCurrent() {
    const id = (CM.game && CM.game.mapId) || (CM.Company && CM.Company.STARTERS[0]);
    if (!id) return;
    A.sel = id; updateCard(); centerCity(id, 3.2);
  }

  /* 右侧动作区：倍速 / 定位 / 全国视野 / 关闭。整条顶栏只有头部会定时重建，
     这里建一次就够，倍速的选中态由 updateHead 同步。 */
  function makeTail() {
    const g = CM.game;
    A.speedBtns = ['暂停', '1×', '3×', '8×'].map(function (t, i) {
      return h('button', {
        class: 'atlas-sp' + (g && g.speed === i ? ' on' : ''), disabled: !g,
        onclick: function () { if (!g) return; A.speedSet = true; CM.ui.setSpeed(i); A.updateHead(); },
      }, t);
    });
    return h('div', { class: 'atlas-tail' },
      h('div', { class: 'atlas-speed', role: 'group', 'aria-label': '时间速度' }, A.speedBtns),
      h('button', {
        class: 'atlas-icobtn', title: '定位当前城市', 'aria-label': '定位当前城市',
        onclick: locateCurrent,
      }, ic('locate', 16)),
      h('button', { class: 'atlas-hbtn', onclick: function () { reset(); } }, '全国视野', ic('expand', 14)),
      h('button', { class: 'iconbtn', 'aria-label': '关闭全国地图', onclick: function () { A.close(); } }, ic('close')));
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
      if (e.key === '/' && A.search && document.activeElement !== A.search) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault(); A.search.focus(); A.search.select(); return;
      }
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
    A.pops = [];
    A.filterBar = makeFilterBar();
    A.tail = makeTail();
    A.card = h('div', { class: 'atlas-card hidden' });
    const bar = h('div', { class: 'atlas-bar' }, A.head, A.filterBar, A.tail);
    const statuses = [['current', '当前'], ['owned', '已进驻'], ['unlocked', '已解锁'], ['failed', '停运'], ['starter', '新手'], ['locked', '未解锁']];
    A.legend = h('div', { class: 'atlas-legend', 'aria-hidden': 'true' },
      statuses.map(function (s) {
        return h('span', null, h('i', { style: { background: statusColorOf(s[0]) } }), s[1]);
      }));
    const hint = h('div', { class: 'atlas-foot' },
      h('div', { class: 'atlas-hint' }, '拖动平移 · 滚轮缩放 · 点击城市 · 按 / 搜索，Enter 定位'),
      h('div', { class: 'atlas-coord' }, '战略视图 · 不加载城市底图'));
    A.el = h('div', { id: 'atlas' }, cv, bar, A.card, A.legend, hint);
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
    if (A.pops) { A.pops.forEach(function (fn) { try { fn(); } catch (e) { /* 关窗时不再抛错 */ } }); A.pops = []; }
    if (A.el) A.el.remove();
    document.body.classList.remove('atlas-open');
    A.last = { x: A.cam.x, y: A.cam.y, zoom: A.cam.zoom };
    const g = A.game;
    if (g && g.speed === 0 && A.prevSpeed > 0 && !A.speedSet && g.setSpeed) g.setSpeed(A.prevSpeed);
    A.el = null; A.cv = null; A.ctx = null; A.head = null; A.card = null; A.filterBar = null; A.count = null; A.legend = null; A.search = null; A.tail = null; A.speedBtns = null;
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
    const mp = cityMeta(id) || {};
    const locked = !CM.Company.isUnlocked(co, id);
    const fee = locked ? CM.Company.unlockFee(id) : 0;
    const gNow = CM.game;
    const gDaily = gNow && gNow.model && gNow.model.daily;
    const liveCover = gDaily && gDaily.ready ? gDaily.coverage : null;
    const src = locked ? CM.Company.pickUnlockSource(co, { sourceMapId: gNow && gNow.mapId, sourceCover: liveCover }) : null;
    if (locked && !src) {
      return A._toast('解锁资格不足：需要一座分部达到覆盖率门槛（入门城 ' +
        U.fmtPct(CM.Company.STARTER_UNLOCK_COVER, 0) + '，其余 ' + U.fmtPct(CM.Company.UNLOCK_COVER, 0) + '）', 'warn');
    }
    const start = locked ? (CM.Company.startFundsFor(id) + src.bonus) : CM.Company.seedFor(co, id);
    if ((co.pool || 0) < fee) {
      return A._toast('公司池不足：开通费需 ' + money(fee) + '（可用 ' + money(co.pool || 0) + '）', 'warn');
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
    const fee = CM.Company.unlockFee(id);
    if (!CM.Company.canStartMap(co, id, 'challenge')) return A._toast('解锁资格不足：需要一座分部达到覆盖率门槛（入门城 ' + U.fmtPct(CM.Company.STARTER_UNLOCK_COVER, 0) + '，其余 ' + U.fmtPct(CM.Company.UNLOCK_COVER, 0) + '；每座分部只能用一次）', 'warn');
    if ((co.pool || 0) < fee) return A._toast('公司池不足：开通费需 ' + money(fee) + '（可用 ' + money(co.pool || 0) + '）', 'warn');
    // 解锁和开城合并为一次事务：城市创建成功后才扣开通费/登记；启动金由市政府注入。
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
