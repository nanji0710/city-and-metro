/* 城轨公司 · 公司面板（多城扩张，本作独有）
 *
 * 这一页回答一个问题：「我这家公司现在有几座城市，下一步能进哪座」。
 *
 * 三条设计约束（与 js/company.js 的文件头一致）：
 *   A. 不重写经济。每个分部仍是完整的一局，这里只做「分部之间转账」的账本。
 *   B. 公司状态存在 localStorage，活得比任何一个分部久（分部可以破产、可以被删）。
 *   C. 每一步都返回 { ok, error }，失败必须显示出来 —— 静默失败会让玩家以为按钮坏了。
 */
(function (CM) {
  'use strict';
  const U = CM.U, h = U.h;
  const UI = CM.UI;
  const snd = function (n) { if (CM.Sound) CM.Sound.play(n); };
  const CO = function () { return CM.Company; };

  function mapOf(id) { return (CM.MAPS && CM.MAPS[id]) || null; }
  function mapName(id) { const m = mapOf(id); return m ? (m.name || id) : id; }

  /* 一座分部的卡。state: 'active' 当前在玩 / 'idle' 有档但没在玩 / 'failed' 已破产。 */
  function branchCard(self, co, b, isCurrent) {
    const mp = mapOf(b.mapId);
    const card = h('div', { class: 'co-branch' + (isCurrent ? ' on' : '') });
    const head = h('div', { class: 'co-bh' },
      h('span', { class: 'badge ' + (b.failed ? 'b-red' : (isCurrent ? 'b-teal' : 'b-blue')) },
        CM.icon(b.failed ? 'warn' : (isCurrent ? 'locate' : 'map'))),
      h('div', { class: 'grow' },
        h('b', null, b.name || mapName(b.mapId)),
        h('div', { class: 'tiny muted' }, mapName(b.mapId) + ' · 第 ' + (mp ? mp.cfg.START.y : '') + ' 年起 · 进驻于 ' + (b.joinedAt || '').slice(0, 10))),
      h('span', { class: 'tag ' + (b.failed ? 'bad' : (isCurrent ? 'est' : '')) },
        b.failed ? '已停运' : (isCurrent ? '当前' : '待续')));
    card.appendChild(head);

    card.appendChild(self.kv([
      ['账面现金', U.fmtMoney(b.funds || 0), 'num'],
      ['上次上缴', b.lastRemit ? (b.lastRemit.y + '年' + b.lastRemit.m + '月 · ' + U.fmtMoney(b.lastRemit.amount || 0)) : '—', 'muted'],
    ]));

    if (!isCurrent) {
      const acts = h('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } });
      acts.appendChild(h('button', {
        class: 'btn sm primary',
        disabled: b.failed || !b.slotId ? true : null,
        'data-tip': b.failed ? '这座城市的分部已经停运' : (b.slotId ? '载入这座城市的最近存档继续经营' : '还没有存档'),
        onclick: function () { self.loadSlot(b.slotId); },
      }, '切换到这座城市'));
      card.appendChild(acts);
    }
    return card;
  }

  /* 可进驻城市列表：按进驻费从低到高，只列出还没进驻的。
   * 能不能进驻看的是**付款分部自己的账**（当前在玩的这座城），不是金库合计 ——
   * 金库是合计值，拿它判「买得起」会出现「A 城有钱 B 城却扣不动」的假绿灯。 */
  /* 付款分部：当前在玩的那座城；它还没登记成分部时退回第一个分部。
   * 面板与 companyJoin 必须用同一套解析，否则列表放行的和点下去扣的不是同一笔钱。 */
  function payerOf(self, co) {
    const g = self.g();
    if (g && g.mapId && CO().branchOf(co, g.mapId)) return g.mapId;
    return co && co.branches.length ? co.branches[0].mapId : null;
  }

  function joinList(self, co) {
    const wrap = h('div', { class: 'co-join' });
    // 可动用额 = 付款分部账面 + 公司自有现金 pool。必须与 Company.canJoin /
    // payAccess 用同一个来源，否则会出现「面板说能进、点下去扣不动」的假绿灯。
    const pid = payerOf(self, co);
    const payerFunds = pid ? CO().available(co, pid) : CO().treasury(co);
    const std = CM.Difficulty ? CM.Difficulty.startFundsOf(self._diffKey || CM.Difficulty.DEFAULT_KEY) : 0;
    const rows = [];
    const hidden = CM.HIDDEN_MAPS || [];
    for (const id in CM.MAPS) {
      const mp = CM.MAPS[id];
      if (mp.tutorial || mp.kind === 'fictional' || hidden.indexOf(id) >= 0) continue;
      if (CO().branchOf(co, id)) continue;
      rows.push({ id: id, fee: CO().accessFee(id), mp: mp });
    }
    rows.sort(function (a, b) { return a.fee - b.fee; });
    if (!rows.length) {
      wrap.appendChild(h('div', { class: 'note' }, '所有城市都已经进驻了。'));
      return wrap;
    }
    for (const r of rows) {
      // 进驻要一次性付：接入费 + 新城的启动金。两者都从付款分部账上划走。
      const start = Math.min(std, Math.max(0, payerFunds - r.fee));
      const need = r.fee + start;
      const short = payerFunds < need;
      const row = h('div', { class: 'co-jrow' + (short ? ' short' : ''), 'data-map': r.id },
        h('span', { class: 'dot', style: { background: 'var(--accent)' } }),
        h('div', { class: 'grow' },
          h('b', null, r.mp.name || r.id),
          h('div', { class: 'tiny muted' }, (r.mp.region || '') + ' · ' + (r.mp.tags || []).join(' · ') +
            (short ? '' : ' · 启动金 ' + U.fmtMoney(start)))),
        h('span', { class: 'co-fee num' }, U.fmtMoney(r.fee)),
        h('button', {
          class: 'btn sm' + (short ? '' : ' primary'),
          disabled: short ? true : null,
          'data-tip': short ? ('这座城的账上还差 ' + U.fmtMoney(need - payerFunds)) : '扣接入费与启动金，在新城市开一局',
          onclick: function () { self.companyJoin(r.id); },
        }, short ? '不够' : '进驻'));
      wrap.appendChild(row);
    }
    return wrap;
  }

  /* 战役地图列表：已解锁可开始（启动金由市政府注入），未解锁需「解锁资格」+ 开通费。 */
  function campaignMapList(self, co) {
    const wrap = h('div', { class: 'co-join' });
    const camp = CO().campaignOf(co) || { unlocked: [] };
    const rows = [], hidden = CM.HIDDEN_MAPS || [];
    for (const id in CM.MAPS) {
      const mp = CM.MAPS[id];
      if (mp.tutorial || mp.kind === 'fictional' || hidden.indexOf(id) >= 0) continue;
      if (CO().branchOf(co, id)) continue;
      rows.push({
        id: id, mp: mp, fee: CO().unlockFee(id), start: CO().startFundsFor(id),
        unlocked: CO().isUnlocked(co, id),
        eligible: CO().canStartMap(co, id, 'challenge'),
        need: CO().acceptNeed(id),
      });
    }
    rows.sort(function (a, b) {
      return (a.unlocked === b.unlocked ? 0 : (a.unlocked ? -1 : 1)) || (a.fee + a.start) - (b.fee + b.start);
    });
    if (!rows.length) {
      wrap.appendChild(h('div', { class: 'note' }, '所有城市都已经进驻了。'));
      return wrap;
    }
    for (const r of rows) {
      const pool = co.pool || 0;
      // 未解锁城市：资格是「验收数 + 第一份合同」；钱只出小额开通费。
      const short = r.unlocked ? false : (!r.eligible || pool < r.fee);
      const tip = r.unlocked ? '启动金由市政府资本金注入，开一局新的经营挑战'
        : (!r.eligible ? '解锁资格不足：完成第一份合同，或把已进驻城市建到验收目标（已验收 ' + CO().acceptedCount(co) + ' 个）'
          : (pool < r.fee ? '公司池还差 ' + U.fmtMoney(r.fee - pool) : '支付开通费 ' + U.fmtMoney(r.fee) + ' 解锁；启动金由市政府注入'));
      const row = h('div', { class: 'co-jrow' + (short ? ' short' : ''), 'data-map': r.id },
        h('span', { class: 'dot', style: { background: r.unlocked ? 'var(--good)' : (r.eligible ? 'var(--accent)' : 'var(--faint)') } }),
        h('div', { class: 'grow' },
          h('b', null, r.mp.name || r.id),
          h('div', { class: 'tiny muted' },
            (CO().STARTER_META[r.id] ? (CO().STARTER_META[r.id].tier === 'advanced' ? '进阶 · ' : '入门 · ') + CO().STARTER_META[r.id].trait + ' · ' : '') +
            (r.mp.trait ? r.mp.trait.name + ' · ' : '') +
            (r.mp.region || '') + ' · ' + (r.mp.tags || []).join(' · ') +
            (r.unlocked ? ' · 启动金 ' + U.fmtMoney(r.start) : ' · 开通费 ' + U.fmtMoney(r.fee) + ' · 验收目标 ' + r.need + ' 站'))),
        h('span', { class: 'co-fee num' }, r.unlocked ? '启动金 ' + U.fmtMoney(r.start) : U.fmtMoney(r.fee)),
        h('button', {
          class: 'btn sm' + (!short ? ' primary' : ''),
          disabled: short ? true : null,
          'data-tip': tip,
          onclick: function () {
            if (r.unlocked) self.companyStartBranch(r.id);
            else self.companyUnlock(r.id);
          },
        }, r.unlocked ? '开始' : (short ? '未达标' : '解锁')));
      wrap.appendChild(row);
    }
    return wrap;
  }

  /* 当前分部的公司注资。注资只允许当前这一局，避免改 localStorage 后被存档覆盖。
   * 额度必须点击时重新读最新公司记录：面板渲染后跨月、注资或上缴都会改变剩余额度，
   * 否则就会出现「按钮写着 1750 万，点下去却说超上限」的假额度。 */
  function injectCard(self, co, g, b) {
    const wrap = h('div', { class: 'co-sec' });
    wrap.appendChild(h('div', { class: 'co-sh' }, h('b', null, '向当前分部注资'), h('span', { class: 'tiny muted' }, '公司池 → 本地现金')));
    if (!g || !b) {
      wrap.appendChild(h('div', { class: 'note' }, '先切换到一座分部，才能向它注资。'));
      return wrap;
    }
    const caps = CO().injectCap(CO().fresh(co) || co, g.mapId, g.clock.y, g.clock.m);
    const pool = CO().poolOf(CO().fresh(co) || co);
    wrap.appendChild(h('div', { class: 'note' },
      '公司池 ' + U.fmtMoney(pool) + '；过去 12 个月正利润 ' + U.fmtMoney(caps.yearProfit) +
      '，发展注资剩余额度 ' + U.fmtMoney(caps.dev) + '；紧急救援剩余额度 ' + U.fmtMoney(caps.rescue) + '。',
      h('br'), '可自定义金额，单位万元（1 亿 = 10000）。留空则按当前模式的全部剩余额度注资；只进当前分部。'));
    const amountIn = h('input', {
      type: 'number', min: 0, step: 100, inputmode: 'decimal',
      class: 'co-inject-input', placeholder: '自定义金额（万元）',
      'aria-label': '自定义注资金额，单位万元',
    });
    const fillMax = function (rescue) {
      const c = CO().injectCap(CO().fresh(co) || co, g.mapId, g.clock.y, g.clock.m);
      const poolNow = CO().poolOf(CO().fresh(co) || co);
      amountIn.value = Math.max(0, Math.round(Math.min(poolNow, rescue ? c.rescue : c.dev)));
    };
    const quick = h('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } },
      h('button', { class: 'btn sm', onclick: function () { fillMax(false); } }, '发展最大'),
      h('button', { class: 'btn sm', onclick: function () { fillMax(true); } }, '救援最大'),
      h('button', { class: 'btn sm', onclick: function () { amountIn.value = ''; } }, '清空'));
    const row = h('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } });
    row.appendChild(h('button', {
      class: 'btn sm primary',
      disabled: pool > 0 ? null : true,
      onclick: function () { self.companyInject(amountIn.value, false); },
    }, '确认发展注资'));
    row.appendChild(h('button', {
      class: 'btn sm',
      disabled: pool > 0 ? null : true,
      onclick: function () { self.companyInject(amountIn.value, true); },
    }, '确认紧急救援'));
    wrap.appendChild(amountIn);
    wrap.appendChild(quick);
    wrap.appendChild(row);
    return wrap;
  }

  UI.prototype.page_company = function () {
    const self = this;
    const el = h('div', { class: 'co-page' });
    const co = CO().active();
    if (!co) {
      el.appendChild(h('div', { class: 'note' }, '还没有公司。先开一局，再回来建立公司。'));
      return { title: '公司', el };
    }
    const g = this.g();
    const treasury = CO().treasury(co);
    const cur = g && g.mapId ? CO().branchOf(co, g.mapId) : null;

    const camp = CO().campaignOf(co);
    const isCampaign = !!(camp && !camp.legacy);
    const cards = h('div', { class: 'fin-cards' });
    cards.append(
      this.stat('公司金库', U.fmtMoney(treasury), '各分部现金 + 公司自有资金', 'good', 'bank'),
      this.stat('公司池', U.fmtMoney(CO().poolOf(co)), '开通新城与向分部注资', 'muted', 'bank'),
      this.stat('分部', co.branches.length + ' 座', co.branches.length > 1 ? '可以同时经营多座城市' : '再进驻一座就能分散风险', 'muted', 'globe'),
      this.stat('上缴比例', Math.round(CO().REMIT_RATE * 100) + '%', '上月净结余（含拨款结余）的 20% 进公司池', 'muted', 'percent'));
    el.appendChild(cards);

    el.appendChild(this.callout('info', 'info',
      '每家分部都是一局完整的地图，各存各的档。金库 = 各分部账面现金 + 公司自有资金（' +
      U.fmtMoney(CO().poolOf(co)) + '）；分部每月按上月净结余（含拨款结余）的 ' + Math.round(CO().REMIT_RATE * 100) + '% 上缴进公司池。' +
      (isCampaign ? '解锁新城市先要有「解锁资格」（分部验收 + 第一份合同），开通费只占小额；启动金由市政府资本金注入。'
        : '旧公司保留全地图权限；新战役只开放入门图温州，其余城市靠验收解锁。')));

    // 公司记录备份：只导出公司账本，城市存档仍走存档管理。
    const file = h('input', {
      type: 'file', accept: '.json,application/json', style: { display: 'none' },
      onchange: function () {
        const f = file.files && file.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function () {
          const r = CO().importData(reader.result, { replace: true });
          if (!r.ok) { self.toast(r.error || '导入失败', 'bad'); return; }
          self.toast('已导入 ' + r.imported + ' 家公司记录' + (r.replaced ? '（覆盖 ' + r.replaced + ' 条）' : ''), 'good');
          self.rerenderPage();
        };
        reader.onerror = function () { self.toast('读取公司记录文件失败', 'bad'); };
        reader.readAsText(f);
        file.value = '';
      },
    });
    const backupRow = h('div', { class: 'row', style: { gap: '6px', margin: '0 0 8px' } },
      h('button', {
        class: 'btn sm',
        onclick: function () {
          const r = CO().exportData();
          if (!r.ok) { self.toast(r.error || '导出失败', 'bad'); return; }
          self.toast('已导出 ' + r.count + ' 家公司记录', 'good');
        },
      }, '导出公司记录'),
      h('button', { class: 'btn sm', onclick: function () { file.click(); } }, '导入公司记录'),
      file);
    if (CM.Atlas) backupRow.appendChild(h('button', {
      class: 'btn sm primary',
      onclick: function () { CM.Atlas.open({ select: g ? g.mapId : null }); },
    }, '打开全国战略地图'));
    el.appendChild(backupRow);

    // 全公司月报：把每个分部最近 12 个月的真实现金流和上缴横向汇总。
    const clock = isCampaign ? CO().campaignClock(co) : null;
    const rows = co.branches.map(function (b) {
      const profits = (b.profits || []).slice().sort(function (a, c) { return a.ym - c.ym; });
      const lastProfit = profits[profits.length - 1] || null;
      const last = b.lastRemit || null;
      const totalPaid = profits.reduce(function (a, p) { return a + (p.paid || 0); }, 0);
      const totalNet = profits.reduce(function (a, p) { return a + (p.net || 0); }, 0);
      return {
        b: b, last: last, lastProfit: lastProfit, totalPaid: totalPaid, totalNet: totalNet,
        name: (mapOf(b.mapId) || {}).name || b.mapId,
      };
    }).sort(function (a, c) { return c.totalPaid - a.totalPaid; });
    const companyPaid = rows.reduce(function (a, r) { return a + r.totalPaid; }, 0);
    const companyNet = rows.reduce(function (a, r) { return a + r.totalNet; }, 0);
    const report = h('div', { class: 'co-sec co-report' },
      h('div', { class: 'co-sh' },
        h('b', null, '全公司月报（近 12 个月）'),
        h('span', { class: 'tiny muted' }, clock ? '公司月份 ' + clock.y + '年' + clock.m + '月 · 上缴 = 净结余（含拨款结余）× ' + Math.round(CO().REMIT_RATE * 100) + '%' : '旧公司不使用统一战役月份')),
      h('div', { class: 'co-report-table' },
        h('div', { class: 'cr head' },
          h('span', null, '分部'), h('span', null, '上次结算'),
          h('span', null, '上月现金流'), h('span', null, '上次上缴'), h('span', null, '近12月上缴')),
        rows.map(function (r) {
          const lastYm = r.last ? r.last.y + '年' + r.last.m + '月' : '—';
          const net = r.lastProfit ? U.fmtMoney(r.lastProfit.net) : '—';
          const paid = r.last ? U.fmtMoney(r.last.amount) : '—';
          return h('div', { class: 'cr' + (r.b.failed ? ' bad' : '') },
            h('span', { class: 'cr-name', title: r.name }, r.name),
            h('span', { title: r.b.failed ? '上次结算 ' + lastYm : null }, r.b.failed ? '已停运' : lastYm),
            h('span', null, net), h('span', null, paid),
            h('span', null, U.fmtMoney(r.totalPaid)));
        }),
        h('div', { class: 'cr total' },
          h('span', null, '全公司'), h('span', null, ''),
          h('span', null, U.fmtMoney(companyNet)), h('span', null, ''),
          h('span', null, U.fmtMoney(companyPaid)))));
    el.appendChild(report);

    if (isCampaign) {
      const ct = CO().contractOf(co, g);
      if (ct) {
        const startName = (mapOf(ct.starterMapId) || {}).name || ct.starterMapId;
        const txt = ct.done
          ? '第一份公司合同已完成：公司池 +' + U.fmtMoney(ct.reward) + '。'
          : (g && g.mapId === ct.starterMapId
            ? '第一份公司合同：在「' + startName + '」新增 ' + CO().STARTER_CONTRACT.addStations +
              ' 站（' + ct.stations + ' / ' + ct.target + '），完成后公司池 +' + U.fmtMoney(ct.reward) + '。'
            : '第一份公司合同：回到起点城「' + startName + '」后查看进度；完成后公司池 +' + U.fmtMoney(ct.reward) + '。');
        el.appendChild(this.callout(ct.done ? 'good' : 'info', 'star', txt));
      }
      const rp = CO().remitPreview(g);
      if (rp) {
        el.appendChild(this.callout(rp.can > 0 ? 'good' : 'warn', 'bank',
          '下次月结预计上缴 ' + U.fmtMoney(rp.can) + '。' + rp.reason +
          (rp.net > 0 ? ' 上月净结余 ' + U.fmtMoney(rp.net) + '，保留 2 个月运营现金 ' + U.fmtMoney(rp.reserve) + '。' : '')));
      }
    }

    const sec1 = h('div', { class: 'co-sec' });
    sec1.appendChild(h('div', { class: 'co-sh' },
      h('b', null, '分部（' + co.branches.length + '）'),
      h('span', { class: 'tiny muted' }, isCampaign ? '月结后自动补结算其它分部 · 上次上缴为真实记录' : '')));
    if (!co.branches.length) sec1.appendChild(h('div', { class: 'note' }, '还没有分部。当前这一局会在第一次自动保存时自动登记。'));
    for (const b of co.branches) {
      sec1.appendChild(branchCard(self, co, b, !!(g && g.mapId === b.mapId && cur)));
    }
    el.appendChild(sec1);

    if (isCampaign && CO().campaignOver(co)) {
      el.appendChild(this.callout('bad', 'error',
        '战役已破产：所有已解锁城市的分部都已停运，公司池也不足最低救援额。可以读取旧存档，或开始新的战役。'));
    }
    if (isCampaign) el.appendChild(injectCard(self, co, g, cur));

    const sec2 = h('div', { class: 'co-sec' });
    sec2.appendChild(h('div', { class: 'co-sh' },
      h('b', null, isCampaign ? '地图与解锁' : '可以进驻的城市'),
      h('span', { class: 'tiny muted' }, isCampaign ? '已解锁可直接开始 · 未解锁从公司池购买' : '按接入费从低到高')));
    sec2.appendChild(isCampaign ? campaignMapList(self, co) : joinList(self, co));
    el.appendChild(sec2);

    el.appendChild(this.sec('co-help', '这套东西是怎么运作的', '', function () {
      return h('div', { class: 'note' },
        '每座城市的账是完全独立的：票价、拨款、债券、破产判定都只看那一座城市自己的数据。',
        h('br'),
        '分部每月把上月净结余（含拨款结余）的 ' + Math.round(CO().REMIT_RATE * 100) + '% 划进公司池，80% 留在本地；本地现金不能跨城使用。',
        h('br'),
        isCampaign ? '解锁新城市的门槛是「分部验收」：把线网建到验收目标（开局规模 + 20% 完整线网，6~20 站），总部发验收奖金并 +1 解锁资格；公司池只付 0.5~1.6 亿开通费，启动金由市政府注入。'
          : '旧公司保留全地图权限；新战役只开放入门图温州，其余城市靠验收解锁。',
        h('br'),
        '一座城市破产不会拖垮公司，但那个分部就停运了；公司池和本地账都空了，才是真正的战役破产。',
        h('br'),
        '金库数字 = 各分部账面现金 + 公司自有资金，所以你在这里看到的钱和你在城市里看到的是同一笔。');
    }, false, 'help'));

    return { title: '公司 · ' + co.name, el };
  };

  /* 进驻新城：确认 → 扣费 → 用新城的启动金开一局。 */
  UI.prototype.companyJoin = function (mapId) {
    const self = this;
    const g = this.g();                 // 付款分部 = 当前正在玩的这座城
    const co = CO().active();
    if (!co) { this.toast('还没有公司', 'warn'); return; }
    // 显式把付款分部传进去：joinOpts → canJoin 的「启动金上限」要按同一个
    // 可动用额算，否则确认框里的启动金可能大于实际付得起的钱。
    const j = CO().joinOpts(co, mapId, CM.Difficulty ? (this._diffKey || CM.Difficulty.DEFAULT_KEY) : 'normal', null, payerOf(self, co));
    if (!j.ok) { this.toast(j.error, 'warn'); return; }
    const mp = mapOf(mapId);
    this.confirm('进驻 ' + (mp ? mp.name : mapId),
      '接入费 ' + U.fmtMoney(j.fee) + '，从当前分部的账上划出（不够再动公司自有资金）；' +
      '新城启动资金 ' + U.fmtMoney(j.startFunds) + '（可动用余额与标准开局资金取较小值）。' +
      '进驻后这一局的盈亏独立结算。',
      '确认进驻', function () {
        const c = CO().get(co.id);
        // 接入费 + 新城启动金都从付款分部账上划走 —— 否则每进一城白拿一笔钱，越扩张越富。
        // 付款分部与列表用的是同一个 payerOf()，保证「列表放行的就扣得动」。
        const pid = payerOf(self, c);
        const pay = CO().payAccess(c, pid, j.fee, j.startFunds);
        if (!pay.ok) { self.toast(pay.error, 'bad'); return; }
        // 只有付款方就是当前这一局时才把余额写回游戏；否则会把别座城的钱搬到眼前这一局。
        if (g && g.econ && pid === g.mapId) g.econ.funds = pay.branch.funds;
        CO().addBranch(c, { mapId: mapId, name: (mp ? mp.name : mapId) + '分部', funds: j.startFunds });
        CO().setActive(c.id);
        snd('build');
        // 先把当前这座城市存下来 —— 切城之后没有回头路，不存就等于把它丢了
        if (g && CM.Save) CM.Save.save(g, 'auto');
        CM.newGame(j.opts);
      }, false, 'globe');
  };

  /* 战役：进入已解锁城市，开一局新的经营挑战。启动金由市政府资本金注入。 */
  UI.prototype.companyStartBranch = function (mapId) {
    const self = this;
    const co = CO().active();
    if (!co) { this.toast('还没有公司', 'warn'); return; }
    if (!CO().isUnlocked(co, mapId)) { this.toast('这座城市尚未解锁', 'warn'); return; }
    if (CO().branchOf(co, mapId)) { this.toast('这座城市已经登记为分部', 'info'); return; }
    const mp = mapOf(mapId);
    if (!mp) { this.toast('地图不存在', 'bad'); return; }
    const start = CO().startFundsFor(mapId);
    const g = this.g();
    this.confirm('开始 ' + (mp.name || mapId),
      '市政府以资本金注入 ' + U.fmtMoney(start) + ' 作为「' + (mp.name || mapId) +
      '」的启动金（不从公司池扣）；把线网建到验收目标还能给公司池挣验收奖金。', '开始经营', function () {
      // 统一走 Atlas 的开城事务：预加载底图 → 创建城市 → 成功后扣池/登记分部。
      if (CM.Atlas && CM.Atlas._newBranch) {
        CM.Atlas._newBranch(mapId);
        return;
      }
      if (g && CM.Save) CM.Save.save(g, 'auto');
      const fresh = CO().get(co.id);
      const before = fresh.pool || 0;
      fresh.pool = before - start;
      const saved = CO().save(fresh);
      if (!saved.ok) { this.toast(saved.error || '公司池写入失败', 'bad'); return; }
      const ab = CO().addBranch(fresh, {
        mapId: mapId, name: (mp.name || mapId) + '分部', funds: start,
      });
      if (!ab.ok) {
        fresh.pool = before;
        CO().save(fresh);
        this.toast(ab.error || '分部登记失败', 'bad');
        return;
      }
      CM.newGame({
        map: mapId, mode: 'challenge',
        difficulty: self._diffKey || (CM.Difficulty ? CM.Difficulty.DEFAULT_KEY : 'normal'),
        name: '经营挑战 · ' + (mp.data.city || mp.name) + ' ' + mp.cfg.START.y,
        company: { id: co.id, name: co.name },
        startFunds: start,
        companyBranch: true,
      });
    }, false, 'play');
  };

  /* 战役：支付开通费解锁新城市。门槛是「解锁资格」，钱只出小额开通费。 */
  UI.prototype.companyUnlock = function (mapId) {
    const co = CO().active();
    if (!co) { this.toast('还没有公司', 'warn'); return; }
    const mp = mapOf(mapId), fee = CO().unlockFee(mapId), start = CO().startFundsFor(mapId);
    if (!CO().canStartMap(co, mapId, 'challenge')) {
      this.toast('解锁资格不足：完成第一份合同，或把已进驻城市建到验收目标（已验收 ' + CO().acceptedCount(co) + ' 个）', 'warn');
      return;
    }
    if ((co.pool || 0) < fee) {
      this.toast('公司池不足：开通费需 ' + U.fmtMoney(fee) + '（可用 ' + U.fmtMoney(co.pool || 0) + '）', 'warn');
      return;
    }
    this.confirm('解锁 ' + (mp ? mp.name : mapId),
      '从公司池支付开通费 ' + U.fmtMoney(fee) + '，取得「' + (mp ? mp.name : mapId) +
      '」的经营权；开城时市政府注入 ' + U.fmtMoney(start) + ' 启动金。把线网建到验收目标（' + CO().acceptNeed(mapId) + ' 站）可获验收奖金并解锁下一城。',
      '确认解锁', function () {
        const r = CO().unlockMap(co, mapId);
        if (!r.ok) { this.toast(r.error || '解锁失败', 'bad'); return; }
        snd('build');
        this.toast('已解锁「' + (mp ? mp.name : mapId) + '」', 'good');
        this.rerenderPage();
      }.bind(this), false, 'map');
  };

  /* 战役：公司池 → 当前分部现金。amount 为空/0 时使用该模式当前最大可用额度。 */
  UI.prototype.companyInject = function (amount, rescue) {
    const g = this.g(), co0 = CO().active();
    if (!g || !co0) { this.toast('没有当前分部', 'warn'); return; }
    // 公司面板可能已经开了几个月；点击确认时必须用最新公司记录和剩余额度重算。
    const co = CO().fresh(co0) || co0;
    let amt = Math.round(Number(amount) || 0);
    const caps = CO().injectCap(co, g.mapId, g.clock.y, g.clock.m);
    const cap = rescue ? caps.rescue : caps.dev;
    if (amt <= 0) amt = Math.round(Math.min(CO().poolOf(co), cap));
    if (amt <= 0) {
      this.toast(rescue ? '没有可用紧急救援额度' : '没有可用发展注资额度', 'warn');
      return;
    }
    if (amt > cap + 1e-6) {
      this.toast('注资超过当前' + (rescue ? '紧急救援' : '发展注资') + '上限（可用 ' + U.fmtMoney(cap) + '）', 'warn');
      return;
    }
    if (CO().poolOf(co) < amt) {
      this.toast('公司池不足（可用 ' + U.fmtMoney(CO().poolOf(co)) + '）', 'warn');
      return;
    }
    this.confirm(rescue ? '紧急救援' : '发展注资',
      '从公司池划出 ' + U.fmtMoney(amt) + ' 到「' + (g.city && g.city.name || g.mapId) + '」的本地现金。' +
      (rescue ? '紧急救援额度按 3 个月运营成本计算。' : '发展注资额度按过去 12 个月正利润的 50% 计算。'),
      '确认注资', function () {
        const r = CO().inject(g, amt, !!rescue);
        if (!r.ok) { this.toast(r.error || '注资失败', 'bad'); return; }
        snd('build');
        this.toast('已注资 ' + U.fmtMoney(amt), 'good');
        this.markUnsaved();
        // 注资已经改了本地现金，必须尽快落盘；否则读回旧档会丢掉这笔钱。
        if (CM.Save) CM.Save.save(g, 'auto');
        this.rerenderPage();
      }.bind(this), false, 'bank');
  };
})(window.CM);
