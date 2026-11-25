'use strict';

(function exposeCostFormat(root) {
  const formatters = {
    CNY: new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    USD: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  };

  function normalizeCostCurrency(value) {
    return value === 'USD' ? 'USD' : 'CNY';
  }

  function formatEstimatedCost(usd, selection, usdToCny) {
    if (!Number.isFinite(usd)) return '—';
    const currency = normalizeCostCurrency(selection);
    if (currency === 'CNY' && (!Number.isFinite(usdToCny) || usdToCny <= 0)) return '—';
    const value = currency === 'USD' ? usd : usd * usdToCny;
    return Number.isFinite(value) ? formatters[currency].format(value) : '—';
  }

  const api = { normalizeCostCurrency, formatEstimatedCost };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokemperatureCostFormat = api;
})(typeof window === 'undefined' ? null : window);
