'use strict';

(function exposeThermal(root) {
  const AMBIENT_TEMP = 22;
  const BOILING_TEMP = 100;
  const MAX_TEMP = 125;
  const COOLING_HALF_LIFE_MS = 10 * 60 * 1000;
  const MIN_AUTO_BOIL_TOKENS = 500000;
  const DAY_MS = 86400000;

  const THERMAL_TIERS = Object.freeze({
    cold: Object.freeze({ id: 'cold', label: '静默待机', short: '待机', color: '#7ab8cc' }),
    warm: Object.freeze({ id: 'warm', label: '正在预热', short: '预热', color: '#f3b559' }),
    hot: Object.freeze({ id: 'hot', label: '火力充沛', short: '火热', color: '#ff7e36' }),
    blazing: Object.freeze({ id: 'blazing', label: '滚烫全开', short: '滚烫', color: '#ff4e2e' }),
    boiling: Object.freeze({ id: 'boiling', label: '沸腾破表', short: '沸腾', color: '#ffd97d' })
  });

  function shiftCalendarDate(dateKey, deltaDays) {
    if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
    const ms = Date.parse(`${dateKey}T00:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + deltaDays * DAY_MS).toISOString().slice(0, 10);
  }

  function tierForTemperature(temp) {
    if (!Number.isFinite(temp)) return THERMAL_TIERS.cold;
    if (temp >= 100) return THERMAL_TIERS.boiling;
    if (temp >= 80) return THERMAL_TIERS.blazing;
    if (temp >= 58) return THERMAL_TIERS.hot;
    if (temp >= 35) return THERMAL_TIERS.warm;
    return THERMAL_TIERS.cold;
  }

  function ratioToBaseTemp(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return AMBIENT_TEMP;
    if (ratio <= 1) return AMBIENT_TEMP + (BOILING_TEMP - AMBIENT_TEMP) * Math.pow(ratio, 0.85);
    return BOILING_TEMP + Math.min(20, 20 * (1 - Math.exp(-(ratio - 1) * 1.2)));
  }

  function autoBoilBaseline(records) {
    return Math.max((records?.avg30Tokens || 0) * 1.8, (records?.historicalPeakTokens || 0) * 0.95, MIN_AUTO_BOIL_TOKENS);
  }

  function computeStreak(byDate, anchorDate, threshold) {
    if (!anchorDate) return 0;
    const todayValue = byDate.get(anchorDate);
    let cursor = Number.isFinite(todayValue) && todayValue >= threshold
      ? anchorDate
      : shiftCalendarDate(anchorDate, -1);
    let streak = 0;
    while (cursor) {
      const value = byDate.get(cursor);
      if (!Number.isFinite(value) || value < threshold) break;
      streak += 1;
      cursor = shiftCalendarDate(cursor, -1);
    }
    return streak;
  }

  function computeHeatRecords(historyDaily = [], todayDate = null) {
    const rows = Array.isArray(historyDaily)
      ? historyDaily
          .filter(row => row && typeof row.date === 'string')
          .slice()
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];
    const anchorDate = todayDate || rows.at(-1)?.date || null;
    const upToToday = anchorDate ? rows.filter(row => row.date <= anchorDate) : rows;
    const pastDays = anchorDate ? rows.filter(row => row.date < anchorDate) : rows;

    const recentPast30 = pastDays.slice(-30);
    const activePast30 = recentPast30.filter(row => Number.isFinite(row.tokens) && row.tokens > 0);
    let avg30Tokens = 0;
    if (activePast30.length > 0) {
      avg30Tokens = activePast30.reduce((sum, row) => sum + row.tokens, 0) / activePast30.length;
    } else {
      const todayRow = upToToday.find(row => row.date === anchorDate);
      if (Number.isFinite(todayRow?.tokens) && todayRow.tokens > 0) avg30Tokens = todayRow.tokens;
    }

    let historicalPeakTokens = 0;
    for (const row of pastDays) {
      if (Number.isFinite(row.tokens) && row.tokens > historicalPeakTokens) historicalPeakTokens = row.tokens;
    }

    let peakDay = null;
    for (const row of upToToday) {
      if (Number.isFinite(row.tokens) && row.tokens > 0 && (!peakDay || row.tokens > peakDay.tokens)) {
        peakDay = { date: row.date, tokens: row.tokens };
      }
    }

    const byDate = new Map(upToToday.map(row => [row.date, row.tokens]));
    const hotThreshold = Math.max(avg30Tokens * 0.7, 1);
    const hotStreakDays = computeStreak(byDate, anchorDate, hotThreshold);
    const activeStreakDays = computeStreak(byDate, anchorDate, 1);

    let weekTrendRatio = null;
    if (anchorDate) {
      const last7Start = shiftCalendarDate(anchorDate, -6);
      const prev7Start = shiftCalendarDate(anchorDate, -13);
      const prev7End = shiftCalendarDate(anchorDate, -7);
      let last7Sum = 0;
      let prev7Sum = 0;
      for (const row of upToToday) {
        if (!Number.isFinite(row.tokens) || row.tokens <= 0) continue;
        if (row.date >= last7Start && row.date <= anchorDate) last7Sum += row.tokens;
        else if (row.date >= prev7Start && row.date <= prev7End) prev7Sum += row.tokens;
      }
      if (prev7Sum > 0) weekTrendRatio = (last7Sum - prev7Sum) / prev7Sum;
    }

    return {
      avg30Tokens,
      historicalPeakTokens,
      peakDay,
      hotStreakDays,
      activeStreakDays,
      weekTrendRatio
    };
  }

  function estimateDayTemperature(dayTokens, records) {
    if (!Number.isFinite(dayTokens)) return null;
    const boilTokens = autoBoilBaseline(records);
    return Math.min(MAX_TEMP, Math.round(ratioToBaseTemp(dayTokens / boilTokens) * 10) / 10);
  }

  function resolveTarget({ todayTokens, todayCostUsd, records, thermostat, cnyRate }) {
    const autoTarget = autoBoilBaseline(records);
    const safeTokens = Number.isFinite(todayTokens) ? Math.max(0, todayTokens) : 0;
    const safeCostUsd = Number.isFinite(todayCostUsd) ? Math.max(0, todayCostUsd) : 0;

    if (thermostat?.mode === 'tokens' && Number.isFinite(thermostat.value) && thermostat.value > 0) {
      return {
        targetKind: 'tokens',
        targetValue: thermostat.value,
        ratio: safeTokens / thermostat.value,
        autoTarget
      };
    }
    if (thermostat?.mode === 'usd' && Number.isFinite(thermostat.value) && thermostat.value > 0) {
      return {
        targetKind: 'usd',
        targetValue: thermostat.value,
        ratio: safeCostUsd / thermostat.value,
        autoTarget
      };
    }
    if (
      thermostat?.mode === 'cny'
      && Number.isFinite(thermostat.value)
      && thermostat.value > 0
      && Number.isFinite(cnyRate)
      && cnyRate > 0
    ) {
      return {
        targetKind: 'cny',
        targetValue: thermostat.value,
        ratio: (safeCostUsd * cnyRate) / thermostat.value,
        autoTarget
      };
    }
    return {
      targetKind: 'auto',
      targetValue: autoTarget,
      ratio: safeTokens / autoTarget,
      autoTarget
    };
  }

  function computeThermalState({
    todayTokens,
    todayCostUsd = 0,
    historyDaily = [],
    todayDate = null,
    burnRateTokensPerMin = 0,
    lastBurnAt = null,
    nowMs = Date.now(),
    runningCount = 0,
    thermostat = null,
    cnyRate = 0
  } = {}) {
    const records = computeHeatRecords(historyDaily, todayDate);
    const { targetKind, targetValue, ratio, autoTarget } = resolveTarget({
      todayTokens,
      todayCostUsd,
      records,
      thermostat,
      cnyRate
    });

    if (!Number.isFinite(todayTokens)) {
      return {
        temperature: null,
        displayTemp: null,
        baseTemp: null,
        liveBoost: 0,
        tier: tierForTemperature(null),
        ratio: 0,
        progressPercent: 0,
        deltaVsAvgC: null,
        burning: false,
        cooling: false,
        targetKind,
        targetValue,
        records,
        alert: { level: 'none' }
      };
    }

    const baseTemp = ratioToBaseTemp(ratio);
    const burnNorm = Math.log1p(Math.max(0, burnRateTokensPerMin || 0) / 1500) / Math.log1p(40);
    const elapsed = lastBurnAt ? Math.max(0, nowMs - lastBurnAt) : Infinity;
    const decay = Number.isFinite(elapsed) ? Math.pow(0.5, elapsed / COOLING_HALF_LIFE_MS) : 0;
    const burstHeat = Math.min(20, burnNorm * 18) * decay;
    const activeRunners = Math.max(0, runningCount || 0);
    const runnerHeat = Math.min(9, activeRunners * 3);
    const liveBoost = Math.min(
      25,
      Math.max(burstHeat, runnerHeat) + (burstHeat > 0 && runnerHeat > 0 ? Math.min(5, runnerHeat * 0.5) : 0)
    );
    const temperature = Math.min(MAX_TEMP, Math.round((baseTemp + liveBoost) * 10) / 10);
    const burning = activeRunners > 0
      || (Number.isFinite(elapsed) && elapsed <= 90_000 && (burnRateTokensPerMin || 0) > 0);
    const cooling = !burning && burstHeat >= 0.5;

    const avgDenom = targetKind === 'tokens' ? targetValue : autoTarget;
    const avgBaseTemp = records.avg30Tokens > 0 ? ratioToBaseTemp(records.avg30Tokens / avgDenom) : null;
    const deltaVsAvgC = avgBaseTemp !== null ? Math.round(baseTemp - avgBaseTemp) : null;

    let alertLevel = 'none';
    if (targetKind !== 'auto') {
      alertLevel = ratio >= 1 ? 'overheat' : ratio >= 0.8 ? 'warning' : 'normal';
    } else if (temperature >= BOILING_TEMP) {
      alertLevel = 'boiling';
    }

    return {
      temperature,
      displayTemp: Math.round(temperature),
      baseTemp: Math.round(baseTemp * 10) / 10,
      liveBoost: Math.round(liveBoost * 10) / 10,
      tier: tierForTemperature(temperature),
      ratio,
      progressPercent: Math.round(ratio * 100),
      deltaVsAvgC,
      burning,
      cooling,
      targetKind,
      targetValue,
      records,
      alert: { level: alertLevel }
    };
  }

  const api = {
    AMBIENT_TEMP,
    BOILING_TEMP,
    MAX_TEMP,
    COOLING_HALF_LIFE_MS,
    THERMAL_TIERS,
    tierForTemperature,
    ratioToBaseTemp,
    computeHeatRecords,
    estimateDayTemperature,
    computeThermalState
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokemperatureThermal = api;
})(typeof window === 'undefined' ? null : window);
