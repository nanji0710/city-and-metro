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
    for (const id in CM.MAPS) {
      const mp = CM.MAPS[id];
      if (mp.tutorial || mp.kind === 'fictional') continue;
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
      const row = h('div', { class: 'co-jrow' + (short ? ' short' : '') },
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

    const cards = h('div', { class: 'fin-cards' });
    cards.append(
      this.stat('公司金库', U.fmtMoney(treasury), '各分部现金 + 公司自有资金', 'good', 'bank'),
      this.stat('分部', co.branches.length + ' 座', co.branches.length > 1 ? '可以同时经营多座城市' : '再进驻一座就能分散风险', 'muted', 'globe'),
      this.stat('上缴比例', Math.round(CO().REMIT_RATE * 100) + '%', '每月从上月净利划入公司自有资金', 'muted', 'percent'));
    el.appendChild(cards);

    el.appendChild(this.callout('info', 'info',
      '每家分部都是一局完整的地图，各存各的档。金库 = 各分部账面现金 + 公司自有资金（' +
      U.fmtMoney(CO().poolOf(co)) + '）；分部每月按上月净利的 ' + Math.round(CO().REMIT_RATE * 100) + '% 上缴进公司自有资金。' +
      '进驻新城市要付接入费与启动金：先扣当前分部的账，不够再动公司自有资金。'));

    const sec1 = h('div', { class: 'co-sec' });
    sec1.appendChild(h('div', { class: 'co-sh' }, h('b', null, '分部（' + co.branches.length + '）')));
    if (!co.branches.length) sec1.appendChild(h('div', { class: 'note' }, '还没有分部。当前这一局会在第一次自动保存时自动登记。'));
    for (const b of co.branches) {
      sec1.appendChild(branchCard(self, co, b, !!(g && g.mapId === b.mapId && cur)));
    }
    el.appendChild(sec1);

    const sec2 = h('div', { class: 'co-sec' });
    sec2.appendChild(h('div', { class: 'co-sh' }, h('b', null, '可以进驻的城市'), h('span', { class: 'tiny muted' }, '按接入费从低到高')));
    sec2.appendChild(joinList(self, co));
    el.appendChild(sec2);

    el.appendChild(this.sec('co-help', '这套东西是怎么运作的', '', function () {
      return h('div', { class: 'note' },
        '每座城市的账是完全独立的：票价、拨款、债券、破产判定都只看那一座城市自己的数据。',
        h('br'),
        '公司层只做两件事：把分部每月净利的 ' + Math.round(CO().REMIT_RATE * 100) + '% 划进金库，以及在你进驻新城时收一次接入费。',
        h('br'),
        '一座城市破产不会拖垮公司，但那个分部就停运了；反过来，金库没钱就进不了新城。',
        h('br'),
        '金库数字 = 各分部账面现金之和，所以你在这里看到的钱和你在城市里看到的是同一笔。');
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
})(window.CM);
