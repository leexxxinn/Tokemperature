'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHub } = require('../src/hub/server');
const { normalizePeriod } = require('../src/shared/usage');
const { createDashboard } = require('../src/web/dashboard');
const { createWebServer } = require('../src/web/server');
const { demoData } = require('../src/web/demo');
const { readConfig } = require('../src/web/cli');
const { createToolSettings } = require('../src/web/tool-settings');
const { createCollectionController } = require('../src/web/collection-controller');
const { formatTokenCount, formatExactTokenCount } = require('../src/web/public/token-format');
const { formatEstimatedCost, normalizeCostCurrency } = require('../src/web/public/cost-format');
const { DEFAULT_CNY_QUOTE, createCnyRateCache } = require('../src/web/cost-rates');
const { CURRENCY_RATES } = require('../src/shared/currency');
const { createDailyProjects, isCalendarDate } = require('../src/web/daily-projects');
const { createThermostatSettings } = require('../src/web/thermostat-settings');
const {
  AMBIENT_TEMP,
  BOILING_TEMP,
  COOLING_HALF_LIFE_MS,
  computeHeatRecords,
  computeThermalState,
  estimateDayTemperature,
  ratioToBaseTemp,
  tierForTemperature
} = require('../src/web/public/thermal');

function dashboard(now = () => new Date()) {
  return createDashboard({ mode: 'local', clients: ['codex'], intervalMs: 300000, now });
}

test('Token counts switch units at the actual thresholds and retain an exact display', () => {
  const examples = new Map([
    [0, '0'], [9999, '9,999'], [10000, '1万'], [123456, '12.35万'], [999999, '99.99万'],
    [1000000, '1百万'], [1005000, '1.01百万'], [9999999, '9.99百万'],
    [10000000, '1千万'], [34500000, '3.45千万'], [99999999, '9.99千万'],
    [100000000, '1亿'], [123000000, '1.23亿'], [undefined, '—']
  ]);
  for (const [value, expected] of examples) assert.equal(formatTokenCount(value), expected);
  assert.equal(formatExactTokenCount(123456789), '123,456,789');
});

test('estimated costs default to CNY and display both currencies with exactly two decimal places', () => {
  assert.equal(normalizeCostCurrency(null), 'CNY');
  assert.equal(normalizeCostCurrency('USD'), 'USD');
  assert.equal(formatEstimatedCost(12.3456, undefined, 6.8), '¥83.95');
  assert.equal(formatEstimatedCost(12.3456, 'USD'), '$12.35');
  assert.equal(formatEstimatedCost(0.0001, 'USD'), '$0.00');
  assert.equal(formatEstimatedCost(0, 'CNY', 6.8), '¥0.00');
  assert.equal(formatEstimatedCost(12, 'CNY', 0), '—');
});

test('CNY quotes persist and keep the last quote if refreshing fails', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokemperature-rates-'));
  const file = path.join(directory, 'exchange-rates.json');
  t.after(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  let timestamp = Date.parse('2026-11-24T10:00:00Z');
  let offline = false;
  let requests = 0;
  const observed = [];
  const usd = Object.fromEntries(Object.entries(CURRENCY_RATES).map(([code, { rate }]) => [code.toLowerCase(), rate]));
  usd.cny = 7.13;
  const cache = createCnyRateCache({ file, now: () => timestamp, onChange: quote => observed.push(quote), fetchImpl: async () => {
    requests += 1;
    if (offline) throw new Error('offline');
    return { ok: true, json: async () => ({ date: '2026-11-24', usd }) };
  } });
  assert.deepEqual(cache.get(), DEFAULT_CNY_QUOTE);
  await cache.refresh();
  const quote = { rate: 7.13, date: '2026-11-24', reference: false };
  assert.deepEqual(observed, [quote]);
  assert.deepEqual(createCnyRateCache({ file }).get(), quote);
  await cache.refresh();
  assert.equal(requests, 1);
  timestamp += 48 * 60 * 60 * 1000;
  offline = true;
  await cache.refresh();
  assert.equal(requests, 3);
  assert.deepEqual(cache.get(), quote);
  assert.deepEqual(observed, [quote]);
  cache.stop();
});

test('default configuration tracks two local tools and rejects invalid options', () => {
  const config = readConfig({}, {});
  assert.deepEqual(config.clients, ['codex', 'claude']);
  assert.equal(config.port, 17322);
  assert.equal(config.watch, true);
  assert.throws(() => readConfig({ port: '65536' }, {}), /端口/);
  assert.throws(() => readConfig({}, { TOKEMPERATURE_CLIENTS: 'typo' }), /采集工具/);
  assert.throws(() => readConfig({}, { TOKEMPERATURE_SINCE: '2026-02-29' }), /日期/);
});

test('dashboard retains the last good snapshot and expires yesterday at local midnight', () => {
  let now = new Date(2026, 4, 31, 23, 57);
  const ui = dashboard(() => now);
  const { record, history, stats } = demoData(now);
  stats.periods.today = normalizePeriod({
    totalTokens: 140, cacheReadTokens: 30, outputTokens: 40, unclassifiedTokens: 10, unpricedTokens: 140,
    clients: { codex: 140 }, clientUnpricedTokens: { codex: 140 }, projects: { example: { tokens: 80, costUsd: 0 } }
  });
  ui.replace(stats, history, record);
  const before = ui.summary().periods.today;
  assert.equal(before.inputTokens, 60);
  assert.equal(before.unclassifiedTokens, 10);
  assert.equal(before.tools[0].unpricedTokens, 140);
  assert.equal(before.projects[0].tokens, 80);
  assert.equal(ui.history(7).daily.at(-1).tokens, 140);
  ui.fail('scan-failed');
  assert.equal(ui.summary().state, 'error');
  assert.deepEqual(ui.summary().periods.today, before);
  now = new Date(2026, 5, 1, 0, 10);
  assert.equal(ui.summary().stale, true);
  assert.equal(ui.summary().periods.today, null);
  assert.equal(ui.summary().periods.month, null);
  assert.ok(ui.summary().periods.allTime.totalTokens > 0);
  assert.equal(ui.history(7).daily.at(-1).tokens, null);
});

test('a day uses its own tool and model costs, and today uses the live snapshot', () => {
  const now = new Date(2026, 10, 24, 12);
  const ui = dashboard(() => now);
  const { stats, record } = demoData(now);
  const old = '2026-11-22';
  ui.replace(stats, { daily: [{
    date: old, tokens: 21, cost: 0.15, unpricedTokens: 3,
    perClient: { codex: { tokens: 18, cost: 0.15 }, claude: { tokens: 3, unpricedTokens: 3 } },
    perModel: { sample: { tokens: 18, cost: 0.15 }, unpriced: { tokens: 3, unpricedTokens: 3 } }
  }] }, record);
  const day = ui.distribution(old);
  assert.equal(day.period.totalTokens, 21);
  assert.equal(day.period.unpricedTokens, 3);
  assert.deepEqual(day.period.tools[0], { id: 'codex', tokens: 18, costUsd: 0.15, unpricedTokens: 0 });
  assert.deepEqual(day.period.models[1], { id: 'unpriced', tokens: 3, costUsd: 0, unpricedTokens: 3 });
  assert.equal(day.projectsAvailable, false);
  assert.deepEqual(day.period.projects, []);
  assert.equal(ui.distribution('2026-11-23').period.totalTokens, 0);
  assert.equal(ui.distribution('2026-11-21').period, null);
  assert.equal(ui.distribution('2026-11-25').period, null);
  const today = ui.distribution('2026-11-24');
  assert.equal(today.period.totalTokens, record.today.totalTokens);
  assert.equal(today.projectsAvailable, true);
  assert.ok(today.period.projects.length);
  const month = ui.history(90);
  assert.equal(month.daily.length, 90);
  assert.equal(month.daily.find(row => row.date === old).tokens, day.period.totalTokens);
  assert.equal(month.daily.at(-1).tokens, today.period.totalTokens);
});

test('daily project snapshots persist in the calendar timezone and require matching history totals', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokemperature-project-days-'));
  const now = new Date(2026, 10, 24, 12);
  const otherDay = '2026-11-22';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const store = createDailyProjects(directory);
  const demo = demoData(now);
  const args = { mode: 'local', clients: ['codex'], intervalMs: 300000, now: () => now };
  const ui = createDashboard({ ...args, dailyProjects: store });
  t.after(() => {
    for (const date of [otherDay, '2026-11-24']) {
      const file = path.join(directory, `${date}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  ui.replace(demo.stats, demo.history, demo.record);
  const reopened = createDailyProjects(directory);
  const saved = reopened.get('2026-11-24', timeZone);
  assert.equal(saved.totalTokens, demo.record.today.totalTokens);
  assert.ok(saved.projects.some(project => project.label === 'tokemperature'));
  assert.equal(reopened.get('2026-11-24', 'invalid-timezone'), null);
  assert.equal(isCalendarDate('2026-02-29'), false);
  assert.equal(isCalendarDate('2024-02-29'), true);

  const row = demo.history.daily.find(entry => entry.date === otherDay);
  const sample = { timeZone, totalTokens: row.tokens, incomplete: false, projects: [saved.projects.at(-1)] };
  store.capture(otherDay, sample);
  ui.replace(demo.stats, demo.history, demo.record);
  assert.deepEqual(ui.distribution(otherDay).period.projects, sample.projects);
  store.capture(otherDay, { ...sample, totalTokens: row.tokens - 1 });
  assert.equal(ui.distribution(otherDay).projectsAvailable, false);
});

test('the in-process Hub persists totals without a second listening port', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokemperature-test-'));
  t.after(() => {
    const file = path.join(directory, 'devices.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  const dataFile = path.join(directory, 'devices.json');
  const hub = createHub({ dataFile });
  const { record } = demoData();
  hub.ingest(record);
  assert.equal(hub.server.listening, false);
  const reopened = createHub({ dataFile });
  assert.equal(reopened.getStats().periods.allTime.totalTokens, record.allTime.totalTokens);
});

test('HTTP serves assets, scoped statistics, exports and revision notifications', { timeout: 10000 }, async t => {
  const demo = demoData();
  const ui = dashboard();
  ui.replace(demo.stats, demo.history, demo.record);
  const web = createWebServer({ dashboard: ui, getExport: () => ({ periods: demo.stats.periods, history: demo.history }) });
  const url = await web.start(0);
  t.after(() => web.stop());

  const html = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const markup = await html.text();
  assert.match(markup, /Tokemperature/);
  assert.ok(markup.indexOf('/token-format.js') >= 0 && markup.indexOf('/token-format.js') < markup.indexOf('/app.js'));
  assert.ok(markup.indexOf('/cost-format.js') >= 0 && markup.indexOf('/cost-format.js') < markup.indexOf('/app.js'));
  assert.match((await fetch(`${url}/token-format.js`)).headers.get('content-type'), /javascript/);
  assert.match((await fetch(`${url}/cost-format.js`)).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
  assert.equal((await fetch(`${url}/api/v1/summary`, { method: 'POST' })).status, 405);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'example.invalid' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const summary = await (await fetch(`${url}/api/v1/summary`)).json();
  assert.equal(summary.periods.today.totalTokens, demo.record.today.totalTokens);
  assert.deepEqual(summary.cnyQuote, DEFAULT_CNY_QUOTE);
  assert.equal(summary.periods.today.sessions, undefined);
  assert.equal(summary.devices, undefined);
  const trend = await (await fetch(`${url}/api/v1/history?days=7`)).json();
  assert.equal(trend.daily.length, 7);
  assert.equal(trend.daily.at(-1).tokens, summary.periods.today.totalTokens);
  assert.equal((await fetch(`${url}/api/v1/history?days=99`)).status, 400);
  const day = await (await fetch(`${url}/api/v1/distribution?date=${trend.end}`)).json();
  assert.equal(day.period.totalTokens, summary.periods.today.totalTokens);
  assert.equal((await fetch(`${url}/api/v1/distribution?date=2026-02-29`)).status, 400);
  const csv = await fetch(`${url}/api/v1/export?format=csv`);
  assert.match(csv.headers.get('content-disposition'), /tokemperature-snapshot\.csv/);
  assert.match(await csv.text(), /period,dimension,name,tokens,cost_usd/);
  const exported = await (await fetch(`${url}/api/v1/export?format=json`)).json();
  assert.equal(exported.snapshot.today.totalTokens, summary.periods.today.totalTokens);

  const response = await fetch(`${url}/api/v1/events`, { signal: AbortSignal.timeout(3000) });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    assert.match(decoder.decode((await reader.read()).value), /"revision":1/);
    ui.fail('scan-failed');
    assert.match(decoder.decode((await reader.read()).value), /"revision":2/);
  } finally {
    await reader.cancel();
  }
});

test('saved tools override startup defaults and an empty selection stays paused after restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokemperature-tools-'));
  const file = path.join(directory, 'tools.json');
  t.after(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  const defaults = ['codex', 'claude'];
  const tools = createToolSettings({ defaults, file });
  assert.equal(tools.get().tools.length, 45);
  assert.deepEqual(tools.update({ revision: 0, clients: ['claude', 'codex'] }).changed, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(tools.update({ revision: 0, clients: [] }).settings.revision, 1);
  assert.deepEqual(tools.update({ revision: 0, clients: defaults }), { error: 'settings_conflict' });
  assert.deepEqual(createToolSettings({ defaults, file }).get().clients, []);
});

test('tool settings HTTP edits require a local same-origin request and valid IDs', { timeout: 10000 }, async t => {
  const ui = dashboard();
  const tools = createToolSettings({ defaults: ['codex'] });
  const changes = [];
  const web = createWebServer({ dashboard: ui, toolSettings: tools, onToolsChanged(clients) {
    changes.push(clients);
    ui.setClients(clients);
  } });
  const url = await web.start(0);
  t.after(() => web.stop());
  const endpoint = url + '/api/v1/tools';
  const send = (data, origin = url, type = 'application/json') => fetch(endpoint, {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': type },
    body: typeof data === 'string' ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(3000)
  });
  const initial = await (await fetch(endpoint)).json();
  assert.deepEqual(initial.clients, ['codex']);
  assert.ok(initial.tools.some(({ id, label }) => id === 'gemini' && label === 'Gemini CLI'));
  assert.equal((await send({ revision: 0, clients: [] }, 'https://example.invalid')).status, 403);
  assert.equal((await send({ revision: 0, clients: [] }, url, 'text/plain')).status, 415);
  assert.equal((await send({ revision: 0, clients: ['codex', 'codex'] })).status, 400);
  assert.equal((await send({ revision: 0, clients: ['unknown'] })).status, 400);
  assert.equal((await send('{')).status, 400);
  assert.equal((await send('x'.repeat(4097))).status, 413);
  const result = await send({ revision: 0, clients: [] });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).clients, []);
  assert.equal(ui.status().state, 'paused');
  assert.deepEqual(changes, [[]]);
  assert.equal((await send({ revision: 0, clients: ['codex'] })).status, 409);
});

test('rapid settings changes drain the previous collector and start only the newest selection', async () => {
  const ui = dashboard();
  const events = [];
  const { promise: draining, resolve: startedDraining } = Promise.withResolvers();
  const { promise: drained, resolve: finishDraining } = Promise.withResolvers();
  const controller = createCollectionController({
    dashboard: ui,
    prepare() { events.push('prepared'); },
    start(clients) {
      const client = clients[0];
      events.push(`start ${client}`);
      return async () => {
        events.push(`stop ${client}`);
        if (client === 'codex') {
          startedDraining();
          await drained;
        }
      };
    }
  });
  await controller.configure(['codex']);
  const first = controller.configure(['claude']);
  await draining;
  const second = controller.configure(['opencode']);
  finishDraining();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['prepared', 'start codex', 'stop codex', 'start opencode']);
  await controller.configure([]);
  assert.equal(ui.status().state, 'paused');
  assert.deepEqual(ui.status().clients, []);
  assert.equal(events.at(-1), 'stop opencode');
  await controller.stop();
});

test('thermal model computes base curve, cooling half-life, heat wave records, and thermostat alerts', () => {
  assert.equal(tierForTemperature(null).id, 'cold');
  assert.equal(tierForTemperature(42).id, 'warm');
  assert.equal(tierForTemperature(65).id, 'hot');
  assert.equal(tierForTemperature(85).id, 'blazing');
  assert.equal(tierForTemperature(103).id, 'boiling');

  assert.equal(ratioToBaseTemp(0), AMBIENT_TEMP);
  assert.equal(ratioToBaseTemp(1), BOILING_TEMP);
  assert.ok(ratioToBaseTemp(2) > BOILING_TEMP && ratioToBaseTemp(2) <= 120);

  const historyDaily = [
    { date: '2026-11-10', tokens: 200000 },
    { date: '2026-11-11', tokens: 200000 },
    { date: '2026-11-12', tokens: 200000 },
    { date: '2026-11-13', tokens: 200000 },
    { date: '2026-11-14', tokens: 200000 },
    { date: '2026-11-15', tokens: 200000 },
    { date: '2026-11-16', tokens: 200000 },
    { date: '2026-11-17', tokens: 400000 },
    { date: '2026-11-18', tokens: 400000 },
    { date: '2026-11-19', tokens: 400000 },
    { date: '2026-11-20', tokens: 400000 },
    { date: '2026-11-21', tokens: 400000 },
    { date: '2026-11-22', tokens: 800000 },
    { date: '2026-11-23', tokens: 500000 },
    { date: '2026-11-24', tokens: 600000 }
  ];
  const records = computeHeatRecords(historyDaily, '2026-11-24');
  assert.ok(Math.abs(records.avg30Tokens - 4700000 / 14) < 1);
  assert.equal(records.historicalPeakTokens, 800000);
  assert.deepEqual(records.peakDay, { date: '2026-11-22', tokens: 800000 });
  assert.equal(records.hotStreakDays, 8);
  assert.equal(records.activeStreakDays, 15);
  assert.ok(Math.abs(records.weekTrendRatio - (3500000 - 1600000) / 1600000) < 1e-6);
  assert.ok(estimateDayTemperature(800000, records) >= 95);

  const nowMs = Date.parse('2026-11-24T12:00:00Z');
  const active = computeThermalState({
    todayTokens: 800000,
    todayCostUsd: 10,
    historyDaily,
    todayDate: '2026-11-24',
    burnRateTokensPerMin: 30000,
    lastBurnAt: nowMs - 5000,
    nowMs,
    runningCount: 2,
    thermostat: { mode: 'tokens', value: 1000000, notify: false }
  });
  assert.equal(active.progressPercent, 80);
  assert.equal(active.alert.level, 'warning');
  assert.equal(active.burning, true);
  assert.equal(active.cooling, false);
  assert.ok(active.liveBoost > 10);

  const halfCooled = computeThermalState({
    todayTokens: 800000,
    todayCostUsd: 10,
    historyDaily,
    todayDate: '2026-11-24',
    burnRateTokensPerMin: 30000,
    lastBurnAt: nowMs - COOLING_HALF_LIFE_MS,
    nowMs,
    runningCount: 0,
    thermostat: { mode: 'tokens', value: 1000000, notify: false }
  });
  assert.equal(halfCooled.burning, false);
  assert.equal(halfCooled.cooling, true);
  assert.ok(halfCooled.liveBoost < active.liveBoost && halfCooled.liveBoost > 4);

  const cnyOverheat = computeThermalState({
    todayTokens: 400000,
    todayCostUsd: 10,
    historyDaily,
    todayDate: '2026-11-24',
    thermostat: { mode: 'cny', value: 60, notify: true },
    cnyRate: 7
  });
  assert.equal(cnyOverheat.alert.level, 'overheat');
  assert.ok(cnyOverheat.temperature >= 100);

  const usdWarning = computeThermalState({
    todayTokens: 400000,
    todayCostUsd: 8.5,
    historyDaily,
    todayDate: '2026-11-24',
    thermostat: { mode: 'usd', value: 10, notify: false }
  });
  assert.equal(usdWarning.alert.level, 'warning');

  const idle = computeThermalState({ todayTokens: null, historyDaily, todayDate: '2026-11-24' });
  assert.equal(idle.temperature, null);
  assert.equal(idle.tier.id, 'cold');
});

test('thermostat settings persist, validate bounds, and detect revision conflicts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokemperature-thermostat-'));
  const file = path.join(directory, 'thermostat.json');
  t.after(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });

  const settings = createThermostatSettings({ file });
  assert.deepEqual(settings.get(), { revision: 0, mode: 'auto', value: 0, notify: false });
  assert.equal(settings.update({ revision: 0, mode: 'auto', value: 0, notify: false }).changed, false);
  assert.equal(fs.existsSync(file), false);

  assert.equal(settings.update({ revision: 0, mode: 'bad', value: 10, notify: false }).error, 'invalid_thermostat');
  assert.equal(settings.update({ revision: 0, mode: 'tokens', value: 12.5, notify: false }).error, 'invalid_thermostat');
  assert.equal(settings.update({ revision: 0, mode: 'cny', value: -5, notify: false }).error, 'invalid_thermostat');
  assert.equal(settings.update({ revision: 0, mode: 'usd', value: 10, notify: 'yes' }).error, 'invalid_thermostat');

  const saved = settings.update({ revision: 0, mode: 'cny', value: 50.129, notify: true });
  assert.equal(saved.changed, true);
  assert.deepEqual(saved.settings, { revision: 1, mode: 'cny', value: 50.13, notify: true });
  assert.equal(settings.update({ revision: 0, mode: 'auto', value: 0, notify: false }).error, 'settings_conflict');
  assert.deepEqual(createThermostatSettings({ file }).get(), { revision: 1, mode: 'cny', value: 50.13, notify: true });
});

test('dashboard computes live burn rate, sparkline, privacy-safe burners, and resets safely', () => {
  let now = new Date(2026, 10, 24, 12, 0, 0);
  const ui = createDashboard({ mode: 'local', clients: ['codex', 'claude'], intervalMs: 300000, now: () => now });
  const sample = demoData(now);
  sample.record.today.sessions = {
    'codex:secret-session': {
      client: 'codex',
      sessionId: 'secret-session',
      title: 'DO NOT LEAK THIS TITLE',
      projectLabel: 'tokemperature',
      latestModel: 'gpt-5.4',
      totalTokens: 500000,
      contextTokens: 160000,
      contextWindow: 200000,
      lastUsedAt: new Date(now.getTime() - 10000).toISOString(),
      turnEnded: false
    }
  };
  ui.replace(sample.stats, sample.history, sample.record);

  now = new Date(now.getTime() + 60000);
  const next = demoData(now);
  next.stats.periods.today.totalTokens = sample.stats.periods.today.totalTokens + 24000;
  next.stats.periods.today.costUsd = sample.stats.periods.today.costUsd + 0.5;
  next.record.today.totalTokens = next.stats.periods.today.totalTokens;
  next.record.today.sessions = sample.record.today.sessions;
  ui.replace(next.stats, next.history, next.record);

  const summary = ui.summary();
  assert.equal(summary.periods.today.sessions, undefined);
  assert.equal(summary.live.tokensPerMin, 24000);
  assert.ok(summary.live.costUsdPerHour > 29.9 && summary.live.costUsdPerHour < 30.1);
  assert.equal(summary.live.sparkline.length, 12);
  assert.equal(summary.live.sparkline.at(-1), 12000);
  assert.equal(summary.live.runningCount, 1);
  assert.deepEqual(summary.live.burners[0], {
    client: 'codex',
    project: 'tokemperature',
    model: 'gpt-5.4',
    state: 'running',
    tokens: 500000,
    contextPercentUsed: 80,
    contextTone: 'caution',
    lastUsedAt: sample.record.today.sessions['codex:secret-session'].lastUsedAt
  });
  assert.equal(summary.live.burners[0].sessionId, undefined);
  assert.equal(summary.live.burners[0].title, undefined);

  // Activity-only patch updates burners without altering token counters.
  const activityRecord = structuredClone(next.record);
  activityRecord.today.sessions['codex:secret-session'].liveActivity = {
    state: 'waiting',
    observedAt: new Date(now.getTime()).toISOString()
  };
  ui.updateLiveActivity(activityRecord);
  assert.equal(ui.summary().live.burners[0].state, 'waiting');
  assert.equal(ui.summary().live.waitingCount, 1);

  // Downward token revision (e.g., disabling a tool) resets burn deltas cleanly.
  const reduced = demoData(now);
  reduced.stats.periods.today.totalTokens = 1000;
  reduced.record.today.totalTokens = 1000;
  ui.replace(reduced.stats, reduced.history, reduced.record);
  assert.equal(ui.summary().live.tokensPerMin, 0);
  assert.equal(ui.summary().live.lastDeltaTokens, 0);
});

test('HTTP serves thermal assets, updated CSP, and thermostat settings API', { timeout: 10000 }, async t => {
  const ui = dashboard();
  const thermostat = createThermostatSettings();
  const changes = [];
  const web = createWebServer({
    dashboard: ui,
    thermostatSettings: thermostat,
    onThermostatChanged(next) { changes.push(next); }
  });
  const url = await web.start(0);
  t.after(() => web.stop());

  const home = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) });
  assert.match(home.headers.get('content-security-policy'), /img-src 'self' data:/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match((await fetch(`${url}/thermal.js`)).headers.get('content-type'), /javascript/);
  assert.match((await fetch(`${url}/thermostat.js`)).headers.get('content-type'), /javascript/);

  const endpoint = `${url}/api/v1/thermostat`;
  const put = (data, origin = url, type = 'application/json') => fetch(endpoint, {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': type },
    body: typeof data === 'string' ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(3000)
  });
  assert.deepEqual(await (await fetch(endpoint)).json(), { revision: 0, mode: 'auto', value: 0, notify: false });
  assert.equal((await put({ revision: 0, mode: 'tokens', value: 1000000, notify: false }, 'https://example.invalid')).status, 403);
  assert.equal((await put({ revision: 0, mode: 'tokens', value: 1000000, notify: false }, url, 'text/plain')).status, 415);
  assert.equal((await put({ revision: 0, mode: 'tokens', value: 0, notify: false })).status, 400);
  assert.equal((await put('x'.repeat(4097))).status, 413);

  const ok = await put({ revision: 0, mode: 'tokens', value: 2000000, notify: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { revision: 1, mode: 'tokens', value: 2000000, notify: true });
  assert.equal(changes.length, 1);
  assert.equal((await put({ revision: 0, mode: 'auto', value: 0, notify: false })).status, 409);

  const html = await home.text();
  assert.match(html, /id="crucible-canvas"/);
  assert.match(html, /id="preview-toggle"/);
  assert.match(html, /id="preview-temp-slider"/);

  const sceneScript = await fetch(`${url}/crucible-scene.js`, { signal: AbortSignal.timeout(3000) });
  assert.equal(sceneScript.status, 200);
  assert.match(sceneScript.headers.get('content-type'), /javascript/);

  const threeModule = await fetch(`${url}/vendor/three/three.module.js`, { signal: AbortSignal.timeout(3000) });
  assert.equal(threeModule.status, 200);
  assert.match(threeModule.headers.get('content-type'), /javascript/);

  const traversalRes = await new Promise((resolve, reject) => {
    http.get(`${url}/vendor/three/../server.js`, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(traversalRes, 404);

  const glbRes = await fetch(`${url}/assets/crucible-reactor.glb`, { signal: AbortSignal.timeout(3000) });
  assert.equal(glbRes.status, 200);
  assert.match(glbRes.headers.get('content-type'), /model\/gltf-binary/);
  const glbBuf = Buffer.from(await glbRes.arrayBuffer());
  assert.equal(glbBuf.subarray(0, 4).toString('ascii'), 'glTF');

  const fallbackRes = await fetch(`${url}/assets/crucible-fallback.png`, { signal: AbortSignal.timeout(3000) });
  assert.equal(fallbackRes.status, 200);
  assert.match(fallbackRes.headers.get('content-type'), /image\/png/);
});
