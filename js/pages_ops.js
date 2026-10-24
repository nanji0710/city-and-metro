/* 城轨公司 · 排班面板（本作独有）
 *
 * 参考项目里发车频率由引擎自己算，玩家只能看着数字。这一页把「多久一班、用哪种
 * 调度策略」交回玩家 —— 因为运营里最核心的决定就是这个，建造是玩家的事，
 * 经营也必须是。
 *
 * 三条设计约束（与 js/ops.js 的文件头一致）：
 *   A. 只做「改参数」，不做「替玩家算最优」—— 没有推荐值，没有自动反解。
 *   B. 稀疏的代价必须走引擎既有因果链（满载率 → 拥挤 → 改走别的路 → 票款掉），
 *      这里不直接扣客流。
 *   C. 玩家随时能切回「交给引擎」，不是一旦动过就回不去。
 */
(function (CM) {
  'use strict';
  const U = CM.U, CFG = CM.CFG, h = U.h;
  const UI = CM.UI;
  const snd = function (n) { if (CM.Sound) CM.Sound.play(n); };
  const O = function () { return CM.Ops; };

  /* 一条线的排班卡：策略按钮 + 两个间隔滑块 + 现状读数。
   * 为什么用滑块而不是输入框：间隔是有物理边界（120~1800 秒）的连续量，
   * 滑块天然表达「你能在这条线上调」，输入框会让人想填 30 秒这种做不到的数。 */
  function lineCard(self, rt, line, isOpen) {
    const g = self.g(), Op = O();
    const pv = Op.preview(rt, line, 0);
    const card = h('div', { class: 'ops-card' + (pv.manual ? ' on' : '') });

    // 头：线路名 + 站数里程 + 状态
    card.appendChild(h('div', { class: 'ops-hd' },
      h('span', { class: 'dot', style: { background: line.color || 'var(--accent)' } }),
      h('b', { class: 'grow' }, line.name || rt.label),
      h('span', { class: 'tag' }, rt.stIdx.length + ' 站'),
      h('span', { class: 'tiny muted num' }, U.fmtKm(rt.lenM)),
      h('span', { class: 'tag ' + (pv.manual ? 'est' : '') }, pv.manual ? '你排班' : '引擎自动')));

    // 读数：当前高峰间隔、所需列车、高峰运力
    card.appendChild(self.kv([
      ['高峰间隔', Op.fmtHeadway(pv.headwaySec), pv.manual ? 'num' : 'muted'],
      ['高峰运力', U.fmtPeople(Math.round(pv.capPerHour)) + ' / 小时', 'num'],
      ['往返需要', pv.trains + ' 列车（单程 ' + Math.round(rt.runSec / 60) + ' 分钟）', 'muted'],
      ['编组', rt.cars + ' 辆 · 定员 ' + U.fmtPeople(rt.cap) + ' 人', 'muted'],
    ]));

    if (!isOpen) return card;

    // 策略
    const polRow = h('div', { class: 'ops-pol' });
    for (const pol of Op.POLICIES) {
      const on = pv.ops.policy === pol.key;
      polRow.appendChild(h('button', {
        class: 'ops-pbtn' + (on ? ' on' : ''),
        'data-tip': pol.desc,
        onclick: function () {
          const r = Op.set(g, line.id, { policy: pol.key });
          if (!r.ok) { self.toast(r.error, 'bad'); return; }
          snd('soft'); self.markUnsaved(); self.rerenderPage();
        },
      }, pol.name));
    }
    card.appendChild(h('div', { class: 'ops-lab tiny muted' }, '调度策略'));
    card.appendChild(polRow);

    // 两个间隔滑块
    const mkSlider = function (label, key, cur) {
      const wrap = h('div', { class: 'ops-sl' });
      const val = h('b', { class: 'num' }, Op.fmtHeadway(cur));
      const inp = h('input', {
        type: 'range', min: Op.MIN_HEADWAY_SEC, max: Op.MAX_HEADWAY_SEC, step: 15,
        value: cur, 'aria-label': label,
      });
      inp.addEventListener('input', function () { val.textContent = Op.fmtHeadway(+inp.value); });
      inp.addEventListener('change', function () {
        const r = Op.set(g, line.id, { [key]: +inp.value });
        if (!r.ok) { self.toast(r.error, 'bad'); return; }
        self.markUnsaved(); self.rerenderPage();
      });
      wrap.append(h('div', { class: 'ops-slhd' }, h('span', { class: 'tiny muted' }, label), val), inp);
      return wrap;
    };
    card.appendChild(mkSlider('高峰间隔（秒）', 'peakHeadwaySec', pv.ops.peakHeadwaySec));
    card.appendChild(mkSlider('平峰间隔（秒）', 'offHeadwaySec', pv.ops.offHeadwaySec));

    // 一句提醒：不判断好坏，只陈述事实
    const note = h('div', { class: 'ops-note tiny muted' });
    if (pv.manual) {
      note.textContent = '车开得越密，车公里成本越高；拉长间隔会让车更挤，乘客会改走别的路。' +
        '往返 ' + Math.round(rt.cycleSec / 60) + ' 分钟，按当前高峰间隔需要 ' + pv.trains + ' 列车才跑得开。';
    } else {
      note.textContent = '当前由引擎按断面客流与线路服务水平自动排班。改动任一滑块即接管这条线。';
    }
    card.appendChild(note);

    if (pv.manual) {
      card.appendChild(h('div', { class: 'row', style: { gap: '4px', marginTop: '6px' } },
        h('button', {
          class: 'btn sm ghost',
          onclick: function () {
            Op.auto(g, line.id); snd('close'); self.markUnsaved(); self.rerenderPage();
          },
        }, '交回引擎自动排班')));
    }
    return card;
  }

  UI.prototype.page_ops = function () {
    const g = this.g(), self = this;
    const el = h('div', { class: 'ops-page' });
    const net = g.compiled;
    if (!net || !net.routes || !net.routes.length) {
      el.appendChild(h('div', { class: 'note' }, '还没有能运营的线路。先去建一条线，再回来排班。'));
      return { title: '排班', el };
    }

    const body = h('div', { class: 'page-enter' });
    el.appendChild(body);

    // 概览：几条线自己排、几条交给引擎、全线高峰总运力
    const mine = net.routes.filter(function (rt) { return O().get(rt.line).manual; });
    let capSum = 0;
    for (const rt of net.routes) capSum += O().preview(rt, rt.line, 0).capPerHour;
    const cards = h('div', { class: 'fin-cards' });
    cards.append(
      this.stat('自己排班', mine.length + ' / ' + net.routes.length, mine.length ? '这些线按你设的间隔发车' : '全部由引擎自动排班', mine.length ? 'good' : 'muted', 'clock'),
      this.stat('高峰总运力', U.fmtPeople(Math.round(capSum)) + ' / 小时', '全部线路早高峰合计', 'muted', 'train'),
      this.stat('调度策略', mine.length ? O().policyName(O().get(mine[0].line).policy) : '—', mine.length ? '按第一条自排线路显示' : '接管后可选四种策略', 'muted', 'settings'));
    body.appendChild(cards);

    body.appendChild(this.callout('info', 'info',
      '排班是你自己的决定，没有「最优解」按钮。车开密了成本上去，开疏了车会挤、乘客会改走别的路。' +
      '两种结果都写在账上，盈亏全看你怎么取舍。'));

    // 每条线一张卡
    for (const rt of net.routes) {
      body.appendChild(lineCard(this, rt, rt.line, true));
    }

    body.appendChild(this.sec('ops-help', '这些数是怎么算的', '', function () {
      return h('div', { class: 'note' },
        '高峰间隔是你设定的目标发车间隔；策略会在它基础上再乘一个系数（保高峰在高峰更密、平峰更疏）。',
        h('br'),
        '「往返需要」= 单程运行时间 × 2 + 终点折返，除以间隔 —— 列车不够时车会挤，而不是凭空多出车来。',
        h('br'),
        '所有数字与结算用的是同一套公式（js/ops.js 与 js/sim.js），所以你在这里看到的就是账上会发生的事。');
    }, false, 'help'));

    return { title: '排班', el };
  };
})(window.CM);
