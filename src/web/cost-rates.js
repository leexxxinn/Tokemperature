'use strict';

const { readJson, writeJsonAtomic } = require('../shared/config');
const { CURRENCY_RATES } = require('../shared/currency');
const { fetchRates, isCacheStale } = require('../shared/exchangeRates');

const DEFAULT_CNY_QUOTE = Object.freeze({ rate: CURRENCY_RATES.CNY.rate, date: null, reference: true });

function createCnyRateCache({ file, onChange, fetchImpl = globalThis.fetch, now = Date.now }) {
  const saved = file && readJson(file);
  let cache = Number.isFinite(saved?.rates?.CNY) && saved.rates.CNY > 0 ? saved : null;
  const shutdown = new AbortController();
  let timer;

  function get() {
    if (!cache) return DEFAULT_CNY_QUOTE;
    const date = typeof cache.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cache.date) ? cache.date : null;
    return { rate: cache.rates.CNY, date, reference: false };
  }

  async function refresh() {
    if (shutdown.signal.aborted || !isCacheStale(cache, now())) return;
    let fetched;
    try {
      fetched = await fetchRates({ fetchImpl: (url, options) => fetchImpl(url, {
        ...options, signal: AbortSignal.any([options.signal, shutdown.signal])
      }) });
    } catch {
      return; // Keep the last usable quote when both sources are unavailable.
    }
    if (shutdown.signal.aborted) return;
    cache = { ...fetched, fetchedAt: now() };
    if (file) {
      try { writeJsonAtomic(file, cache); }
      catch (error) { console.warn('缓存汇率失败。', error.message); }
    }
    onChange?.(get());
  }

  return {
    get,
    refresh,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), 60 * 60 * 1000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      shutdown.abort();
    }
  };
}

module.exports = { DEFAULT_CNY_QUOTE, createCnyRateCache };
