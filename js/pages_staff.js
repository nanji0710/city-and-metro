/* 城轨公司 · 人员面板（本作独有）
 *
 * 参考项目没有人员系统：运营成本只有「车公里 + 站务」两项，班次自动配车，
 * 玩家建完线只能看数字走。这一页要让「人」成为玩家可以直接干预的第三条曲线。
 *
 * 页面分两块：
 *   1. 我的团队 —— 已经花了钱在干什么，每个人的效果、解雇、改派
 *   2. 人才市场 —— 花钱的地方，每月刷新，过期就没了
 *
 * 为什么人才市场必须有过期日：常驻市场会让玩家「等最好的那个」永远不下手，
 * 有到期日才形成「现在这个够用了吗」的决策。
 */
(function (CM) {
  'use strict';
  const U = CM.U, CFG = CM.CFG, h = U.h;
  const UI = CM.UI;
  const snd = function (n) { if (CM.Sound) CM.Sound.play(n); };

  // 角色在 UI 上的图标（CM.ICON 里的键）
  const ROLE_ICON = {
    line_manager: 'shield',
    dispatcher: 'clock',
    driver: 'train',
    maintainer: 'hammer',
    station_staff: 'people',
    commercial: 'bag',
  };

  function money(wan) { return U.fmtMoney(wan); }

  // 一个候选人 / 在职人员共用的卡片
  function personCard(self, p, opts) {
    const g = self.g(), S = CM.Staff, on = !!opts.on;
    const role = S.ROLE_BY_KEY[p.role] || { name: p.role, desc: '' };
    const L = S.LEVELS[Math.max(0, Math.min(4, (p.level | 0) - 1))] || S.LEVELS[0];
    const card = h('div', { class: 'ps-card' + (on ? ' on' : '') });

    card.appendChild(h('div', { class: 'ps-top' },
      h('span', { class: 'badge b-blue' }, CM.icon(ROLE_ICON[p.role] || 'people')),
      h('div', { class: 'grow' },
        h('div', { class: 'ps-meta' },
          h('span', { class: 'tag' }, role.name),
          h('span', { class: 'tiny muted' }, L.name),
          p.lineId ? h('span', { class: 'tag est' }, (g.net.lines[p.lineId] && g.net.lines[p.lineId].name) || '已指派') : null),
        h('b', { class: 'ps-name' }, p.name)),
      h('div', { class: 'ps-pay' }, h('b', { class: 'num' }, money(p.salary)), h('small', { class: 'muted' }, '每月'))));

    // 效率条
    const eff = Math.round((p.efficiency || L.eff) * 100);
    card.appendChild(h('div', { class: 'ps-eff' },
      h('span', { class: 'tiny muted' }, '效率'),
      h('div', { class: 'ps-bar' }, h('i', { style: { width: eff + '%' } })),
      h('span', { class: 'tiny num' }, eff + '%')));

    // 特性
    if (p.traits && p.traits.length) {
      card.appendChild(h('div', { class: 'ps-traits' }, p.traits.map(function (t) {
        const good = t.value < 1 ? (t.key !== 'salary') : (t.key === 'sat' || t.key === 'onTime' || t.key === 'loyalty');
        return h('span', { class: 'ps-trait ' + (good ? 'good' : 'bad'), 'data-tip': t.text }, t.name);
      })));
    } else {
      card.appendChild(h('div', { class: 'ps-traits' }, h('span', { class: 'tiny muted' }, '没有特别之处')));
    }

    // 效果一句话
    card.appendChild(h('div', { class: 'ps-desc' }, role.desc));

    // 操作
    const row = h('div', { class: 'row', style: { gap: '4px', flexWrap: 'wrap', marginTop: '6px' } });
    if (!on) {
      const fee = p.signingFee || S.signingFeeOf(p.role, p.level, g.clock.y, p.traits);
      row.appendChild(h('button', {
        class: 'btn sm primary',
        onclick: function () {
          const r = g.staff.hire(p.id, null, g.econ);
          if (r && r.error) { self.toast(r.error, 'bad'); return; }
          g.invalidateStaff(); g.rev++; snd('good');
          self.toast('已聘用 ' + p.name, 'good');
          self.rerenderPage();
        },
      }, '聘用 · ' + money(fee)));
      if (p.expiresAt != null) {
        const left = Math.max(0, p.expiresAt - (g.clock.y * 12 + g.clock.m - 1));
        row.appendChild(h('span', { class: 'tiny muted' }, left > 0 ? '还有 ' + left + ' 个月' : '本月到期'));
      }
    } else {
      // 指派线路
      const sel = h('select', { class: 'sel' });
      sel.appendChild(h('option', { value: '' }, '全城（不限线路）'));
      for (const lid in g.net.lines) {
        const ln = g.net.lines[lid];
        sel.appendChild(h('option', { value: lid }, ln.name));
      }
      sel.value = p.lineId || '';
      sel.addEventListener('change', function () {
        g.staff.assign(p.id, sel.value || null);
        g.invalidateStaff(); g.rev++; snd('soft');
        self.rerenderPage();
      });
      row.appendChild(sel);
      row.appendChild(h('button', {
        class: 'btn sm ghost danger',
        onclick: function () {
          self.confirm('解雇 ' + p.name + '？', '解约金为半个月工资（' + money((p.salary || 0) / 2) + '）。解雇后这个位置会空出来，事故需要你自己处置。', '解雇', function () {
            g.staff.fire(p.id, g.econ);
            g.invalidateStaff(); g.rev++; snd('close');
            self.toast('已解雇 ' + p.name, 'info');
            self.rerenderPage();
          }, true);
        },
      }, '解雇'));
    }
    card.appendChild(row);
    return card;
  }

  UI.prototype.page_staff = function (id) {
    const g = this.g(), self = this, S = CM.Staff;
    if (!g.staff) return { title: '人员', el: h('div', { class: 'note' }, '本局没有启用人员体系。') };

    const tab = id || this.staffTab || 'team';
    this.staffTab = tab;
    const el = h('div', { class: 'ps-page' });

    el.appendChild(this.pageTabs([
      ['team', '我的团队 ' + g.staff.hired.length, 'people'],
      ['market', '人才市场 ' + g.staff.market.length, 'search'],
    ], tab, function (t) {
      self.staffTab = t;
      const top = self.stack[self.stack.length - 1];
      if (top && top.kind === 'staff') top.id = t;
      self.renderPage(false); self.rBody.scrollTop = 0;
    }));

    const se = g.staffEffects() || S.effects(g.staff, g.clock.y);
    const lineAutoN = se.lineAuto ? Object.keys(se.lineAuto).length : 0;
    const body = h('div', { class: 'page-enter' });
    el.appendChild(body);

    // 概览：在编、月薪、日薪、自动处置
    const cards = h('div', { class: 'fin-cards' });
    cards.append(
      this.stat('在编人数', String(se.headcount), se.headcount > 8 ? '超过 8 人效率开始稀释' : '人手充足', se.headcount > 8 ? 'warn' : 'muted', 'people'),
      this.stat('工资总额', money(se.payroll * 30), '每月 · 日结 ' + money(se.payroll), 'muted', 'wallet'),
      this.stat('事故处置', se.autoHandle ? '自动' : (lineAutoN ? '按线自动' : '手动'), se.autoHandle ? '线长在线，全网事故自动处置（更贵更慢）' : (lineAutoN ? lineAutoN + ' 条线有专属线长，只有这些线自动处置' : '没有线长，事故要你亲手点'), (se.autoHandle || lineAutoN) ? 'good' : 'bad', 'shield'));
    body.appendChild(cards);

    // 效果汇总
    const effRows = [];
    if (se.incidentMult < 1) effRows.push(['事故率', '×' + se.incidentMult.toFixed(2), 'good']);
    if (se.onTimeAdd > 0) effRows.push(['事故影响时长', '−' + (Math.min(0.35, se.onTimeAdd) * 100).toFixed(1) + '%', 'good']);
    if (se.satAdd > 0) effRows.push(['满意度', '+' + se.satAdd.toFixed(1), 'good']);
    if (se.maintMult < 1) effRows.push(['维保成本', '×' + se.maintMult.toFixed(2), 'good']);
    if (se.revenueMult > 1) effRows.push(['票款与广告', '×' + se.revenueMult.toFixed(3), 'good']);
    if (se.repairMult < 1) effRows.push(['维修费', '×' + se.repairMult.toFixed(2), 'good']);
    if (effRows.length) {
      body.appendChild(this.sec('ps-eff', '当前队伍带来的效果', '', function () {
        return self.kv(effRows);
      }, true, 'sparkle'));
    } else {
      body.appendChild(this.callout('warn', 'warn', '现在一个人都没有。地铁可以无人运营，但事故只能你亲手处置，满意度也会低 6 点左右。'));
    }

    // 团队 / 市场
    if (tab === 'team') {
      if (!g.staff.hired.length) {
        body.appendChild(h('div', { class: 'note' }, '团队是空的。去「人才市场」看看 —— 每个月换一批人，过期的就没了。'));
      } else {
        const grid = h('div', { class: 'ps-grid' });
        for (const p of g.staff.hired) grid.appendChild(personCard(this, p, { on: true }));
        body.appendChild(grid);
      }
    } else {
      if (!g.staff.market.length) {
        body.appendChild(h('div', { class: 'note' }, '本月没有候选人。下个月会刷新一批。'));
      } else {
        const grid = h('div', { class: 'ps-grid' });
        for (const p of g.staff.market) grid.appendChild(personCard(this, p, { on: false }));
        body.appendChild(grid);
      }
      body.appendChild(this.sec('ps-note', '市场怎么运作', '', function () {
        return h('div', { class: 'note' },
          '每月初换一批候选人，每人最多留 3 个月，到期就走。聘用要付一笔签约费，之后按月发工资（日结）。',
          h('br'),
          '工资随年份通胀上涨；在职满 2 年的老员工每年 1 月会要求涨薪。',
          h('br'),
          '六种角色各管一摊：线长让事故自动处置、调度与司机缩短事故影响时长、检修压低维保与维修费、站务提满意度、商业提票款与广告。');
      }, false, 'help'));
    }

    // 突发记录
    const inc = (g.lastIncidents || []).slice(-5).reverse();
    body.appendChild(this.sec('ps-inc', '最近的事故', inc.length ? inc.length + ' 条' : '无', function () {
      const box = h('div');
      if (!inc.length) { box.appendChild(h('div', { class: 'note' }, '最近没有事故。')); return box; }
      for (const r of inc) {
        const lv = CM.Incidents && CM.Incidents.LEVEL_BY_LV[r.lv];
        box.appendChild(h('div', { class: 'ps-inc-row' },
          h('span', { class: 'tag ' + (r.lv >= 3 ? 'bad' : '') }, 'L' + r.lv),
          h('div', { class: 'grow' },
            h('b', null, (lv ? lv.name : r.title) + ' · ' + r.lineName),
            h('div', { class: 'tiny muted' }, '影响 ' + r.minutes + ' 分钟 · ' + (r.handled ? (r.mode === 'ignore' ? '未处置' : (r.mode === 'auto' ? '线长自动处置' : '你亲手处置')) : '待处置'))),
          r.handled ? null : h('button', {
            class: 'btn sm primary',
            onclick: function () {
              const c = g.handleIncident(r.id);
              if (c && c.error) self.toast(c.error, 'bad');
              else { snd('good'); self.toast('已处置', 'good'); self.rerenderPage(); }
            },
          }, '处置 · ' + money(r.cost))));
      }
      return box;
    }, inc.length > 0, 'bolt'));

    return { title: '人员', el: el };
  };

  // 顶栏入口：把人数的角标挂在按钮上
  UI.prototype.staffCount = function () {
    const g = this.g();
    if (!g || !g.staff) return 0;
    return g.staff.hired.length;
  };
})(window.CM);
