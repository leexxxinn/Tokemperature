'use strict';

const { localDayKey } = require('../shared/history');
const { aggregateDevices } = require('../shared/usage');
const { dayOffset } = require('./dashboard');

const SOURCES = [
  ['codex', 'gpt-5.4', 0.56, 8.5],
  ['claude', 'claude-sonnet-4-6', 0.29, 6.8],
  ['codex', 'gpt-5.3-codex', 0.15, 4.2]
];
const PROJECTS = [['tokemperature', 0.52], ['design-system', 0.27], ['api-service', 0.15]];

function demoData(now = new Date()) {
  const today = localDayKey(now);
  const days = Array.from({ length: 96 }, (_, index) => {
    const tokens = 300000 + ((index * 793697) % 1680500);
    const partitions = SOURCES.map(([tool, model, share, rate]) => {
      const count = Math.floor(tokens * share);
      return { tool, model, tokens: count, cost: count * rate / 1000000 };
    });
    return { date: dayOffset(today, index - 95), partitions };
  });

  function period(rows) {
    const value = { totalTokens: 0, costUsd: 0, clients: {}, clientCosts: {}, models: {}, modelCosts: {} };
    for (const { partitions } of rows) {
      for (const { tool, model, tokens, cost } of partitions) {
        value.totalTokens += tokens;
        value.costUsd += cost;
        value.clients[tool] = (value.clients[tool] || 0) + tokens;
        value.clientCosts[tool] = (value.clientCosts[tool] || 0) + cost;
        value.models[model] = (value.models[model] || 0) + tokens;
        value.modelCosts[model] = (value.modelCosts[model] || 0) + cost;
      }
    }
    value.outputTokens = Math.floor(value.totalTokens * 0.08);
    value.cacheReadTokens = Math.floor(value.totalTokens * 0.64);
    value.cacheWriteTokens = Math.floor(value.totalTokens * 0.05);
    value.projects = Object.fromEntries(PROJECTS.map(([label, share]) => [label, {
      label, tokens: Math.floor(value.totalTokens * share), costUsd: value.costUsd * share
    }]));
    return value;
  }

  const todayPeriod = period(days.slice(-1));
  const nowMs = now.getTime();
  todayPeriod.sessions = {
    'codex:demo-1': {
      client: 'codex',
      sessionId: 'demo-1',
      projectLabel: 'tokemperature',
      latestModel: 'gpt-5.4',
      totalTokens: Math.floor(todayPeriod.totalTokens * 0.42),
      contextTokens: 136000,
      contextWindow: 200000,
      lastUsedAt: new Date(nowMs - 15000).toISOString(),
      turnEnded: false
    },
    'claude:demo-2': {
      client: 'claude',
      sessionId: 'demo-2',
      projectLabel: 'design-system',
      latestModel: 'claude-sonnet-4-6',
      totalTokens: Math.floor(todayPeriod.totalTokens * 0.24),
      contextTokens: 78000,
      contextWindow: 200000,
      lastUsedAt: new Date(nowMs - 45000).toISOString(),
      turnEnded: false,
      liveActivity: { state: 'waiting', observedAt: new Date(nowMs - 5000).toISOString() }
    }
  };

  const record = {
    deviceId: 'demo',
    updatedAt: now.toISOString(),
    today: todayPeriod,
    month: period(days.filter(row => row.date.startsWith(today.slice(0, 7)))),
    allTime: period(days),
    periodWindows: {
      today: { key: today, endsAt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString() },
      month: { key: today.slice(0, 7), endsAt: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString() }
    }
  };
  const ratePerToken = todayPeriod.totalTokens > 0 ? todayPeriod.costUsd / todayPeriod.totalTokens : 0;
  const demoRatesPerMin = [14200, 16800, 15400, 19600, 22400, 20500, 24800, 27600, 23900, 21200, 25800, 22600];
  const burnSamples = demoRatesPerMin.map((rate, index) => {
    const bucketEndOffset = (demoRatesPerMin.length - 1 - index) * 2 * 60 * 1000 + 15000;
    const tokens = rate * 2;
    return {
      ts: nowMs - bucketEndOffset,
      tokens,
      costUsd: tokens * ratePerToken
    };
  });
  const history = { daily: [], monthly: [] };
  for (const row of days) {
    const value = period([row]);
    history.daily.push({
      date: row.date, tokens: value.totalTokens, cost: value.costUsd,
      perClient: Object.fromEntries(Object.entries(value.clients).map(([id, tokens]) => [id, { tokens, cost: value.clientCosts[id] }])),
      perModel: Object.fromEntries(Object.entries(value.models).map(([id, tokens]) => [id, { tokens, cost: value.modelCosts[id] }]))
    });
  }
  const months = new Map();
  for (const day of history.daily) {
    const month = day.date.slice(0, 7);
    const value = months.get(month) || { month, tokens: 0, cost: 0 };
    value.tokens += day.tokens;
    value.cost += day.cost;
    months.set(month, value);
  }
  history.monthly = Array.from(months.values());
  return { record, history, stats: aggregateDevices([record], 600000, now.getTime()), burnSamples };
}

module.exports = { demoData };
