'use strict';
/* 新手教程（温州）：不再使用独立青湾地图。
 * 教程只引导温州战役的前 7 步：看线网 → 扩建 3 站 → 第一份合同 → 公司池 → 全国地图。
 * 旧青湾教程存档仍保留，但不再挂新教程；地图也仍在 CM.MAPS 中供旧档读取。 */
(function (CM) {
  const U = CM.U, h = U.h;
  const ic = function (n, s) { return CM.icon(n, s); };
  const snd = function (n) { if (CM.Sound) CM.Sound.play(n); };
  let ui = null, g = null, el = null, idx = -1, ctx = {}, doneAt = 0, target = null, mini = false, lastCheck = 0;

  const absMin = function (c) { return (U.ymIndex(c.y, c.m) * 31 + c.d) * 1440 + c.minute; };
  const stationCount = function () { return Object.keys((g && g.net && g.net.stations) || {}).length; };
  const campaignDone = function () {
    const co = CM.Company && CM.Company.active();
    if (!co || !co.campaign) return;
    const fresh = CM.Company.fresh(co) || co;
    if (fresh.campaign) {
      fresh.campaign.tutorialDone = true;
      if (CM.Company.save) CM.Company.save(fresh);
    }
  };

  // 步骤：manual 需按钮继续；final 完成后进入全国图。
  const STEPS = [
    { id: 'intro', title: '欢迎来到温州', manual: '开始新手战役',
      body: '温州是公司接手的第一个城市：1 号线已经有 4 座车站，但城市还没有真正扩张。接下来用 6 个小目标学会扩建、第一份公司合同和全国地图。教程可以随时跳过。' },
    { id: 'move', title: '先熟悉地图',
      body: '按住左键拖动地图，滚轮缩放。按 T 可以在 2D 与 2.5D 之间切换。',
      hint: '试着拖动或缩放一下。',
      enter: function () { const c = ui.R.cam; ctx.cam0 = { x: c.cx, y: c.cy, z: c.zoom }; },
      check: function () { const c = ui.R.cam, c0 = ctx.cam0; return U.dist(c.cx, c.cy, c0.x, c0.y) > 3 || Math.abs(Math.log(c.zoom / c0.z)) > 0.25; } },
    { id: 'line', title: '看看已有的 1 号线',
      body: '点击地图上已有的 1 号线，右侧会显示这条线的车站、发车间隔与客流。以后新建的线路也会在这里管理。',
      hint: '先把鼠标移到橙色线路上，再点击。',
      check: function () { return ui.topIs && ui.topIs(['line']); } },
    { id: 'build', title: '为温州扩建 3 座车站',
      body: '用底部「建站」或「绘线」工具，在 1 号线附近新增 3 座车站并确认建设。扩建 3 站后会触发公司给温州的第一份合同。',
      hint: '不要拆掉原有车站；目标是新增 3 站。',
      target: function () { return ui.tbtns && ui.tbtns.station; },
      enter: function () { if (g.tutorial && g.tutorial.buildBase == null) g.tutorial.buildBase = stationCount(); ctx.base = (g.tutorial && g.tutorial.buildBase) || stationCount(); },
      check: function () {
        const ct = CM.Company && CM.Company.contractOf ? CM.Company.contractOf(CM.Company.active(), g) : null;
        const targetN = ct ? ct.target : (ctx.base || stationCount()) + 3;
        if (stationCount() >= targetN) {
          if (CM.Company && CM.Company.checkStarterContract) CM.Company.checkStarterContract(g);
          return true;
        }
        return false;
      } },
    { id: 'company', title: '第一份合同与公司池',
      body: '打开顶栏「公司」：温州的第一份合同已完成，公司池获得 +7 亿。合同还给你 +1 解锁资格；之后每把一座城市建到验收目标，资格再 +1。',
      hint: '公司面板里可以看到每座城市的验收目标。',
      target: function () { return ui.hbtns && ui.hbtns.company; },
      check: function () { return ui.topIs && ui.topIs(['company']); } },
    { id: 'run', title: '让时间走起来',
      body: '关闭公司面板，按空格或点击 ▶ 让温州开始运营。时间会按月推进，公司池也会按分部的净结余继续变化。',
      hint: '让游戏时间走过 3 小时；之后随时可以回到全国地图。',
      target: function () { return g.speed > 0 ? (g.speed === 1 ? ui.tbtns.s2 : null) : ui.tbtns.pause; },
      enter: function () { if (g.tutorial.runT0 == null) g.tutorial.runT0 = absMin(g.clock); ctx.t0 = g.tutorial.runT0; },
      check: function () { return absMin(g.clock) - (ctx.t0 || 0) >= 180; } },
    { id: 'done', title: '去全国地图', final: true,
      body: '温州已经跑起来了。打开全国地图：绿色是已进驻，灰色城市要先「验收解锁」——把温州线网再建到目标站数，就能解锁下一座城。' },
  ];
  const TASKS = STEPS.filter(function (s) { return !s.manual && !s.final; }).length;

  function setTarget(t) {
    if (target === t) return;
    if (target) target.classList.remove('coach-target');
    target = t || null;
    if (target) target.classList.add('coach-target');
  }
  function applyHL() { /* 温州教程不需要地图高亮；保留接口给旧步骤结构 */ }
  function openAtlas() {
    if (CM.Atlas) {
      setTimeout(function () { CM.Atlas.open({ select: g && g.mapId }); }, 260);
      return true;
    }
    if (ui && ui.showMapSelect) { setTimeout(function () { ui.showMapSelect(); }, 260); return true; }
    return false;
  }
  function go(i) {
    idx = U.clamp(i, 0, STEPS.length - 1);
    if (!g.tutorial) g.tutorial = { step: 0, done: [] };
    g.tutorial.step = idx;
    doneAt = 0; ctx = {};
    const st = STEPS[idx];
    if (st.enter) st.enter();
    applyHL(st);
    if (st.final) { g.tutorial.complete = true; snd('fanfare'); }
    if (ui) { ui.markUnsaved(); ui.scheduleAutosave && ui.scheduleAutosave(); }
    render();
  }
  function complete() {
    if (doneAt) return;
    const st = STEPS[idx];
    doneAt = performance.now();
    if (g.tutorial.done.indexOf(st.id) < 0) g.tutorial.done.push(st.id);
    snd('good');
    render();
  }
  function finish() {
    if (g && g.tutorial) { g.tutorial.complete = true; g.tutorial.step = STEPS.length - 1; }
    campaignDone();
    if (ui) { ui.markUnsaved(); ui.doAutosave && ui.doAutosave(true); }
    Tutorial.detach();
    openAtlas();
  }
  function render() {
    if (!el) return;
    const st = STEPS[idx], n = idx, ok = !!doneAt;
    el.className = 'hud glass' + (mini ? ' mini' : '') + (ok ? ' ok' : '');
    el.innerHTML = '';
    const pct = Math.round(Math.min(n, TASKS + 1) / (TASKS + 1) * 100);
    const head = h('div', { class: 'co-head' },
      h('span', { class: 'co-badge' }, ic('help', 14), '新手教程'),
      h('span', { class: 'co-step' }, st.final ? '全部完成' : (n === 0 ? '共 ' + TASKS + ' 个任务' : '任务 ' + n + ' / ' + TASKS)),
      h('span', { class: 'grow' }),
      h('button', { class: 'iconbtn', 'data-tip': mini ? '展开' : '收起', onclick: function () { mini = !mini; render(); } }, ic(mini ? 'expand' : 'minus')));
    el.append(head, h('div', { class: 'co-bar' }, h('i', { style: { width: pct + '%' } })));
    if (mini) { el.appendChild(h('div', { class: 'co-mini' }, ok ? '✓ ' : '', st.title)); syncLayout(); return; }
    el.appendChild(h('div', { class: 'co-title' }, ok ? h('span', { class: 'co-check' }, ic('check', 16)) : null, st.title));
    el.appendChild(h('div', { class: 'co-body' }, st.body));
    if (st.hint && !ok) el.appendChild(h('div', { class: 'co-hint' }, ic('info', 14), h('span', null, st.hint)));
    const acts = h('div', { class: 'co-acts' });
    if (st.final) {
      acts.append(
        h('button', { class: 'btn sm ghost', onclick: function () { Tutorial.detach(true); } }, '稍后再说'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm primary', onclick: finish }, '进入全国地图', ic('chev', 14)));
    } else if (st.manual) {
      acts.append(h('button', { class: 'btn sm ghost', onclick: function () { Tutorial.detach(true); } }, '跳过教程'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm primary', onclick: function () { go(idx + 1); } }, st.manual, ic('chev', 14)));
    } else {
      acts.append.apply(acts, [
        h('button', { class: 'btn sm ghost', disabled: idx <= 1 ? true : null, onclick: function () { go(idx - 1); } }, '上一步'),
        h('span', { class: 'grow' }),
        ok ? h('span', { class: 'co-done' }, '完成！') : h('button', { class: 'btn sm ghost', onclick: function () { go(idx + 1); } }, '跳过'),
        ok ? h('button', { class: 'btn sm primary', onclick: function () { go(idx + 1); } }, '下一步', ic('chev', 14)) : null].filter(Boolean));
    }
    el.appendChild(acts);
    syncLayout();
  }
  function syncLayout() {
    if (!el) return;
    requestAnimationFrame(function () { if (el) document.documentElement.style.setProperty('--coach-h', el.offsetHeight + 'px'); });
  }

  const Tutorial = {
    attach: function (u, game) {
      ui = u; g = game;
      if (!g || !g.tutorial) return;
      Tutorial.detach();
      ui = u; g = game;
      // 旧青湾教程：保留旧存档可读，不再挂新步骤。
      if (g.mapId === 'tutorial') {
        if (g.tutorial) { g.tutorial.complete = true; g.tutorial.step = STEPS.length - 1; }
        return;
      }
      if (g.tutorial.complete) return;
      el = h('aside', { id: 'coach' });
      document.getElementById('app').appendChild(el);
      document.body.classList.add('has-coach');
      if (ui.placeFeed) ui.placeFeed();
      mini = false;
      go(g.tutorial.step || 0);
    },
    detach: function (quit) {
      if (quit && g && g.tutorial) {
        g.tutorial.complete = true; g.tutorial.step = STEPS.length - 1;
        campaignDone();
        if (ui) { ui.markUnsaved(); ui.doAutosave && ui.doAutosave(true); ui.toast('已跳过教程，正在打开全国地图', 'info'); }
      }
      setTarget(null);
      if (el) { el.remove(); el = null; }
      document.body.classList.remove('has-coach');
      if (ui && ui.placeFeed) ui.placeFeed();
      idx = -1;
      if (quit) openAtlas();
    },
    active: function () { return !!el; },
    tick: function () {
      if (!el || !g || CM.game !== g || idx < 0) return;
      const st = STEPS[idx];
      const now = performance.now();
      setTarget(!doneAt && st.target && !ui.blocking() ? st.target() : null);
      if (doneAt) { if (now - doneAt > 1400) go(idx + 1); return; }
      if (!st.check || now - lastCheck < 250) return;
      lastCheck = now;
      let ok = false;
      try { ok = st.check(); } catch (e) { ok = false; }
      if (ok) complete();
    },
  };
  CM.Tutorial = Tutorial;
})(window.CM);
