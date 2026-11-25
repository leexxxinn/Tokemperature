'use strict';

(function exposeTokenFormat(root) {
  const digits = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const truncated = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, roundingMode: 'trunc' });
  const units = [[100000000, '亿'], [10000000, '千万'], [1000000, '百万'], [10000, '万']];

  function formatExactTokenCount(value) {
    return Number.isFinite(value) ? digits.format(value) : '—';
  }

  function formatTokenCount(value) {
    if (!Number.isFinite(value)) return '—';
    const magnitude = Math.abs(value);
    const index = units.findIndex(([limit]) => magnitude >= limit);
    if (index === -1) return digits.format(value);
    const [limit, unit] = units[index];
    // Keep values below a unit boundary in their original unit, even if rounding would cross it.
    const roundsUp = index > 0 && magnitude >= units[index - 1][0] - limit / 200;
    return `${(roundsUp ? truncated : digits).format(value / limit)}${unit}`;
  }

  const api = { formatTokenCount, formatExactTokenCount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokemperatureTokenFormat = api;
})(typeof window === 'undefined' ? null : window);
