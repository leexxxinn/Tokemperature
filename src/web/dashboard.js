'use strict';

const { localDayKey } = require('../shared/history');
const {
  sessionActivityState,
  sessionContextForRow,
  sessionWithActivity,
  isArchivedSession
} = require('../shared/sessionLive');
const { DEFAULT_CNY_QUOTE } = require('./cost-rates');

const PERIODS = ['today', 'month', 'allTime'];
const COMPONENTS = ['outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const BURN_WINDOW_MAX_MS = 30 * 60 * 1000;
const SPARKLINE_BUCKETS = 12;
const SPARKLINE_BUCKET_MS = 2 * 60 * 1000;
const SPARKLINE_SPAN_MS = SPARKLINE_BUCKETS * SPARKLINE_BUCKET_MS;
const MIN_SAMPLE_SPAN_MS = 10 * 1000;
const MAX_BURNERS = 8;

function dayOffset(key, offset) {
  const day = new Date(`${key}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

function breakdown(tokens = {}, costs = {}, unpriced = {}) {
  return Object.entries(tokens).map(([id, count]) => ({
    id,
    tokens: count,
    costUsd: costs[id] || 0,
    unpricedTokens: unpriced[id] || 0
  })).sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
}

function projectBreakdown(projects = {}) {
  return Object.entries(projects).map(([id, project]) => ({
    id,
    label: project.label || id,
    tokens: project.tokens,
    costUsd: project.costUsd,
    unpricedTokens: project.unpricedTokens || 0
  })).sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
}

function historyBreakdown(entries = {}) {
  return Object.entries(entries).map(([id, row]) => ({
    id,
    tokens: row.tokens || 0,
    costUsd: row.cost || 0,
    unpricedTokens: row.unpricedTokens || 0
  })).sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
}

function summarizePeriod(period) {
  const components = Object.fromEntries(COMPONENTS.map(key => [key, period[key] || 0]));
  const known = Object.values(components).reduce((sum, value) => sum + value, 0);
  const remainder = Math.max(0, period.totalTokens - known);
  const unclassifiedTokens = Math.min(remainder, period.unclassifiedTokens || 0);
  return {
    ...components,
    inputTokens: remainder - unclassifiedTokens,
    totalTokens: period.totalTokens,
    costUsd: period.costUsd,
    unpricedTokens: period.unpricedTokens || 0,
    unclassifiedTokens,
    tools: breakdown(period.clients, period.clientCosts, period.clientUnpricedTokens),
    models: breakdown(period.models, period.modelCosts, period.modelUnpricedTokens),
    projects: projectBreakdown(period.projects)
  };
}

function dayValues(row = {}) {
  return {
    tokens: row.tokens || 0,
    costUsd: row.cost || 0,
    tools: Object.fromEntries(Object.entries(row.perClient || {}).map(([key, value]) => [key, value.tokens])),
    models: Object.fromEntries(Object.entries(row.perModel || {}).map(([key, value]) => [key, value.tokens]))
  };
}

function createDashboard({ mode, clients, intervalMs, dailyProjects, now = () => new Date() }) {
  const listeners = new Set();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const burnRateWindowMs = intervalMs > 15 * 60 * 1000 ? 30 * 60 * 1000 : 15 * 60 * 1000;
  let snapshot;
  let revision = 0;
  let state = 'starting';
  let message = null;
  let cnyQuote = DEFAULT_CNY_QUOTE;
  let burnSamples = [];
  let burnBuckets = [];
  let lastBurnAt = null;
  let lastDeltaTokens = 0;
  let lastDeltaAt = null;

  function status() {
    const lastSuccessAt = snapshot?.lastSuccessAt ?? null;
    const stale = lastSuccessAt !== null && now().getTime() - Date.parse(lastSuccessAt) > intervalMs * 2;
    return { mode, state, stale, revision, message, lastSuccessAt, timeZone, clients };
  }

  function broadcast() {
    revision += 1;
    const event = status();
    for (const listener of listeners) listener(event);
  }

  function resetBurnTracking() {
    burnSamples = [];
    burnBuckets = [];
    lastBurnAt = null;
    lastDeltaTokens = 0;
    lastDeltaAt = null;
  }

  function pruneBurnTracking(currentMs) {
    burnSamples = burnSamples.filter(entry => currentMs - entry.ts <= BURN_WINDOW_MAX_MS && entry.ts <= currentMs).slice(-120);
    burnBuckets = burnBuckets.filter(entry => currentMs - entry.ts < SPARKLINE_SPAN_MS && entry.ts <= currentMs).slice(-240);
  }

  function recordBurnSample(dayKey, totalTokens, costUsd, currentMs, { restored = false, baselineTs = currentMs } = {}) {
    if (!dayKey || !Number.isFinite(totalTokens)) return;
    if (restored) {
      if (currentMs - baselineTs <= BURN_WINDOW_MAX_MS && baselineTs <= currentMs) {
        burnSamples = [{ ts: baselineTs, dayKey, totalTokens, costUsd }];
      }
      return;
    }
    const previous = burnSamples.at(-1);
    if (!previous || previous.dayKey !== dayKey || totalTokens < previous.totalTokens) {
      resetBurnTracking();
      burnSamples.push({ ts: currentMs, dayKey, totalTokens, costUsd });
      return;
    }
    const deltaTokens = totalTokens - previous.totalTokens;
    const deltaCostUsd = Math.max(0, costUsd - previous.costUsd);
    if (currentMs > previous.ts) {
      burnSamples.push({ ts: currentMs, dayKey, totalTokens, costUsd });
    } else if (currentMs === previous.ts) {
      previous.totalTokens = totalTokens;
      previous.costUsd = costUsd;
    }
    if (deltaTokens > 0) {
      lastBurnAt = currentMs;
      lastDeltaTokens = deltaTokens;
      lastDeltaAt = currentMs;
      burnBuckets.push({ ts: currentMs, tokens: deltaTokens, costUsd: deltaCostUsd });
    }
    pruneBurnTracking(currentMs);
  }

  function topModelForSession(session) {
    if (session?.latestModel) return session.latestModel;
    let bestModel = '';
    let bestTokens = -1;
    for (const [model, count] of Object.entries(session?.models || {})) {
      if (count > bestTokens) {
        bestTokens = count;
        bestModel = model;
      }
    }
    return bestModel;
  }

  function extractLiveBurners(currentMs) {
    const todayRaw = snapshot?.todayPeriodRaw;
    if (!todayRaw?.sessions || periods()?.today === null) {
      return { burners: [], runningCount: 0, waitingCount: 0 };
    }
    const active = [];
    let runningCount = 0;
    let waitingCount = 0;
    for (const [key, raw] of Object.entries(todayRaw.sessions)) {
      const session = sessionWithActivity(todayRaw, key, raw, currentMs);
      if (!session || isArchivedSession(session)) continue;
      const activityState = sessionActivityState(session, currentMs);
      if (activityState !== 'running' && activityState !== 'waiting') continue;
      if (activityState === 'running') runningCount += 1;
      else waitingCount += 1;
      const context = sessionContextForRow(session, currentMs);
      active.push({
        client: session.client || '',
        project: String(session.projectLabel || '').trim(),
        model: topModelForSession(session),
        state: activityState,
        tokens: Math.max(0, Math.round(Number(session.totalTokens) || 0)),
        contextPercentUsed: context?.percentUsed ?? null,
        contextTone: context?.tone || '',
        lastUsedAt: session.lastUsedAt || ''
      });
    }
    active.sort((a, b) => {
      if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      return String(b.lastUsedAt).localeCompare(String(a.lastUsedAt));
    });
    return { burners: active.slice(0, MAX_BURNERS), runningCount, waitingCount };
  }

  function computeLiveMetrics(currentMs) {
    const currentDay = localDayKey(new Date(currentMs));
    const today = periods()?.today;
    const expectedDay = snapshot?.calendar?.today?.key;
    if (!today || (expectedDay && expectedDay !== currentDay)) {
      return {
        tokensPerMin: 0,
        costUsdPerHour: 0,
        lastBurnAt: null,
        lastDeltaTokens: 0,
        lastDeltaAt: null,
        sparkline: Array(SPARKLINE_BUCKETS).fill(0),
        burners: [],
        runningCount: 0,
        waitingCount: 0
      };
    }

    pruneBurnTracking(currentMs);
    const activeSamples = burnSamples.filter(
      entry => entry.dayKey === currentDay && currentMs - entry.ts <= burnRateWindowMs && entry.ts <= currentMs
    );
    let tokensPerMin = 0;
    let costUsdPerHour = 0;
    if (activeSamples.length >= 2) {
      const first = activeSamples[0];
      const last = activeSamples.at(-1);
      const sampleSpan = last.ts - first.ts;
      if (sampleSpan >= MIN_SAMPLE_SPAN_MS) {
        const effectiveSpan = Math.max(sampleSpan, Math.min(burnRateWindowMs, currentMs - first.ts));
        const dTokens = Math.max(0, last.totalTokens - first.totalTokens);
        const dCost = Math.max(0, last.costUsd - first.costUsd);
        if (effectiveSpan > 0 && dTokens > 0) {
          tokensPerMin = Math.round(dTokens / (effectiveSpan / 60000));
          costUsdPerHour = Math.round((dCost / (effectiveSpan / 3600000)) * 10000) / 10000;
        }
      }
    }
    if (tokensPerMin === 0 && burnBuckets.length > 0) {
      const recentWindowMs = 2 * 60 * 1000;
      let recentTokens = 0;
      let recentCost = 0;
      for (const bucket of burnBuckets) {
        if (currentMs - bucket.ts <= recentWindowMs && bucket.ts <= currentMs) {
          recentTokens += bucket.tokens;
          recentCost += bucket.costUsd;
        }
      }
      if (recentTokens > 0) {
        tokensPerMin = Math.round(recentTokens / 2);
        costUsdPerHour = Math.round(recentCost * 30 * 10000) / 10000;
      }
    }

    const bucketTotals = Array(SPARKLINE_BUCKETS).fill(0);
    for (const bucket of burnBuckets) {
      const age = currentMs - bucket.ts;
      if (age >= 0 && age < SPARKLINE_SPAN_MS) {
        const slot = SPARKLINE_BUCKETS - 1 - Math.floor(age / SPARKLINE_BUCKET_MS);
        bucketTotals[slot] += bucket.tokens;
      }
    }
    const sparkline = bucketTotals.map(total => Math.round(total / 2));
    const { burners, runningCount, waitingCount } = extractLiveBurners(currentMs);
    return {
      tokensPerMin,
      costUsdPerHour,
      lastBurnAt,
      lastDeltaTokens,
      lastDeltaAt,
      sparkline,
      burners,
      runningCount,
      waitingCount
    };
  }

  function replace(stats, history, device, { restored = false } = {}) {
    const periods = Object.fromEntries(PERIODS.map(key => [key, summarizePeriod(stats.periods[key])]));
    const indexedHistory = new Map((history?.daily || []).map(row => [row.date, row]));
    const day = device.periodWindows?.today?.key;
    const today = device.periods?.today || device.today;
    if (dailyProjects && day && today && device.projectsEnabled !== false) {
      try {
        dailyProjects.capture(day, {
          timeZone: device.periodWindows.timeZone || timeZone,
          totalTokens: today.totalTokens,
          projects: projectBreakdown(today.projects),
          incomplete: Boolean(device.periodProjectsOmitted?.today)
        });
      } catch (error) {
        console.warn('保存每日项目用量失败。', error.message);
      }
    }
    const currentMs = now().getTime();
    const lastSuccessAt = device.updatedAt || device.receivedAt;
    const baselineTs = Date.parse(lastSuccessAt);
    recordBurnSample(
      day || localDayKey(new Date(currentMs)),
      periods.today?.totalTokens ?? 0,
      periods.today?.costUsd ?? 0,
      currentMs,
      { restored, baselineTs: Number.isFinite(baselineTs) ? baselineTs : currentMs }
    );
    snapshot = {
      periods,
      indexedHistory,
      firstDay: indexedHistory.keys().next().value,
      calendar: device.periodWindows,
      todayPeriodRaw: today || null,
      projectsIncomplete: stats.projectsIncomplete === true,
      todayProjectsIncomplete: Boolean(device.periodProjectsOmitted?.today),
      projectsEnabled: device.projectsEnabled !== false,
      lastSuccessAt
    };
    state = restored ? 'starting' : 'ready';
    message = null;
    broadcast();
  }

  function updateLiveActivity(device) {
    if (!snapshot || !device) return;
    const day = device.periodWindows?.today?.key;
    if (day && snapshot.calendar?.today?.key && day !== snapshot.calendar.today.key) return;
    const today = device.periods?.today || device.today;
    if (!today) return;
    snapshot.todayPeriodRaw = today;
    broadcast();
  }

  function seedBurnHistory(samples = []) {
    if (!snapshot || !Array.isArray(samples) || !samples.length) return;
    const currentMs = now().getTime();
    const dayKey = snapshot.calendar?.today?.key || localDayKey(new Date(currentMs));
    const todayTotal = snapshot.periods?.today?.totalTokens || 0;
    const todayCost = snapshot.periods?.today?.costUsd || 0;
    const valid = samples
      .filter(entry => entry && Number.isFinite(entry.ts) && entry.ts <= currentMs && Number.isFinite(entry.tokens) && entry.tokens >= 0)
      .slice()
      .sort((a, b) => a.ts - b.ts);
    if (!valid.length) return;

    burnBuckets = valid
      .filter(entry => entry.tokens > 0 && currentMs - entry.ts < SPARKLINE_SPAN_MS)
      .map(entry => ({
        ts: entry.ts,
        tokens: entry.tokens,
        costUsd: Number.isFinite(entry.costUsd) && entry.costUsd >= 0 ? entry.costUsd : 0
      }));

    const latestPositive = burnBuckets.at(-1);
    lastBurnAt = latestPositive ? latestPositive.ts : null;
    lastDeltaTokens = latestPositive ? latestPositive.tokens : 0;
    lastDeltaAt = latestPositive ? latestPositive.ts : null;

    let runningTokens = todayTotal;
    let runningCost = todayCost;
    const synthesized = [{ ts: valid.at(-1).ts, dayKey, totalTokens: runningTokens, costUsd: runningCost }];
    for (let i = valid.length - 1; i >= 1; i -= 1) {
      runningTokens = Math.max(0, runningTokens - valid[i].tokens);
      runningCost = Math.max(0, runningCost - (Number(valid[i].costUsd) || 0));
      synthesized.unshift({ ts: valid[i - 1].ts, dayKey, totalTokens: runningTokens, costUsd: runningCost });
    }
    burnSamples = synthesized;
    pruneBurnTracking(currentMs);
    broadcast();
  }

  function periods() {
    if (!snapshot) return null;
    const current = { ...snapshot.periods };
    const timestamp = now().getTime();
    for (const key of ['today', 'month']) {
      const end = Date.parse(snapshot.calendar?.[key]?.endsAt);
      if (Number.isFinite(end) && timestamp >= end) current[key] = null;
    }
    return current;
  }

  function historyRow(date, end) {
    return snapshot?.indexedHistory.get(date)
      ?? (snapshot?.firstDay && date >= snapshot.firstDay && date < end ? { tokens: 0 } : null);
  }

  function distribution(date) {
    const end = localDayKey(now());
    const today = date === end && snapshot?.calendar?.today?.key === end ? periods()?.today : null;
    if (today) return {
      date, period: today, projectsAvailable: snapshot.projectsEnabled, projectsIncomplete: snapshot.todayProjectsIncomplete
    };
    const row = date <= end && historyRow(date, end);
    if (!row) return { date, period: null, projectsAvailable: false, projectsIncomplete: false };
    const saved = dailyProjects?.get(date, timeZone);
    const projectSnapshot = saved?.totalTokens === row.tokens ? saved : null;
    return {
      date,
      period: {
        totalTokens: row.tokens || 0,
        costUsd: row.cost || 0,
        unpricedTokens: row.unpricedTokens || 0,
        tools: historyBreakdown(row.perClient),
        models: historyBreakdown(row.perModel),
        projects: projectSnapshot?.projects || []
      },
      projectsAvailable: !row.tokens || Boolean(projectSnapshot),
      projectsIncomplete: projectSnapshot?.incomplete === true
    };
  }

  function history(days) {
    const end = localDayKey(now());
    const start = dayOffset(end, 1 - days);
    const today = periods()?.today;
    const liveToday = today && snapshot.calendar?.today?.key === end ? {
      tokens: today.totalTokens,
      costUsd: today.costUsd,
      tools: Object.fromEntries(today.tools.map(row => [row.id, row.tokens])),
      models: Object.fromEntries(today.models.map(row => [row.id, row.tokens]))
    } : null;
    const daily = Array.from({ length: days }, (_, index) => {
      const date = dayOffset(start, index);
      if (date === end && liveToday) return { date, ...liveToday };
      const row = historyRow(date, end);
      return { date, ...(row ? dayValues(row) : { tokens: null }) };
    });
    return { start, end, daily, timeZone };
  }

  return {
    status,
    history,
    distribution,
    replace,
    updateLiveActivity,
    seedBurnHistory,
    setClients(next) {
      clients = [...next];
      state = mode === 'demo' ? 'ready' : clients.length ? 'starting' : 'paused';
      message = null;
      broadcast();
    },
    setCnyQuote(quote) {
      if (quote.rate === cnyQuote.rate && quote.date === cnyQuote.date && quote.reference === cnyQuote.reference) return;
      cnyQuote = quote;
      broadcast();
    },
    summary() {
      return {
        ...status(),
        periods: periods(),
        cnyQuote,
        projectsIncomplete: snapshot?.projectsIncomplete || false,
        live: computeLiveMetrics(now().getTime())
      };
    },
    fail(reason) {
      state = 'error';
      message = reason;
      broadcast();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

module.exports = { createDashboard, dayOffset };
