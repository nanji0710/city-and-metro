'use strict';
/* 多分部后台结算进度：独立于城市 HUD / 全国图，任何界面都能看到。
 * Company.settleInactive() 负责真实结算，这里只负责显示，不参与账目。 */
(function (CM) {
  const U = CM.U, h = U.h;
  const S = { el: null, bar: null, tx: null, sub: null, timer: 0 };

  function ensure() {
    if (S.el) return;
    S.bar = h('i', { style: { width: '0%' } });
    S.tx = h('b', null, '正在结算其他分部');
    S.sub = h('span', null, '0 / 0');
    S.el = h('div', { id: 'settle-progress', class: 'settle-progress hidden', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'settle-head' }, S.tx, S.sub),
      h('div', { class: 'settle-bar' }, S.bar),
      h('div', { class: 'settle-note' }, '正在恢复各分部存档并按真实月份结算；完成后继续时间。'));
    document.body.appendChild(S.el);
  }

  CM.SettleUI = {
    show: function (total, label) {
      ensure();
      S.el.classList.remove('hidden');
      S.el.classList.remove('done');
      S.tx.textContent = label || '正在结算其他分部';
      S.sub.textContent = '0 / ' + total;
      S.bar.style.width = '0%';
    },
    update: function (done, total, label, complete) {
      if (!S.el) return;
      const pct = total ? Math.min(100, Math.round(done / total * 100)) : 100;
      S.bar.style.width = pct + '%';
      S.sub.textContent = done + ' / ' + total;
      if (label) S.tx.textContent = label;
      if (complete) {
        S.el.classList.add('done');
        S.tx.textContent = '分部结算完成';
        S.sub.textContent = '100%';
      }
    },
    hide: function (delay) {
      if (!S.el) return;
      clearTimeout(S.timer);
      S.timer = setTimeout(function () {
        if (!S.el) return;
        S.el.classList.add('hidden');
        S.el.classList.remove('done');
      }, delay == null ? 700 : delay);
    },
  };
})(window.CM);
