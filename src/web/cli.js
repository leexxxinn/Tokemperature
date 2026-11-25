'use strict';

const path = require('node:path');
const { createDashboard } = require('./dashboard');
const { createWebServer } = require('./server');
const { createToolSettings } = require('./tool-settings');
const { createThermostatSettings } = require('./thermostat-settings');
const { createCollectionController } = require('./collection-controller');
const { createCnyRateCache } = require('./cost-rates');
const { createDailyProjects } = require('./daily-projects');
const { parseArgs, loadDotEnv } = require('../shared/config');
const { CLIENT_IDS } = require('../shared/clientCatalog');
const { normalizeClientsCsv } = require('../shared/clientTracking');

const ROOT = path.resolve(__dirname, '../..');

function numericOption(raw, label, fallback, min, max) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} 必须是 ${min} 至 ${max} 之间的整数`);
  return value;
}

function readConfig(args, env) {
  const demo = args.demo === true;
  const clients = normalizeClientsCsv(env.TOKEMPERATURE_CLIENTS ?? 'codex,claude').split(',').filter(Boolean);
  const unsupported = clients.filter(client => !CLIENT_IDS.includes(client));
  if (!clients.length || unsupported.length) throw new Error(`采集工具配置无效 ${unsupported.join(', ')}`.trim());
  const since = env.TOKEMPERATURE_SINCE || '2024-01-01';
  const startDate = new Date(`${since}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(startDate.getTime()) || startDate.toISOString().slice(0, 10) !== since) {
    throw new Error('TOKEMPERATURE_SINCE 必须为有效的 YYYY-MM-DD 日期');
  }
  return {
    demo,
    clients: demo ? ['codex', 'claude'] : clients,
    deviceId: 'local',
    port: numericOption(args.port ?? env.TOKEMPERATURE_PORT, '端口', 17322, 1, 65535),
    intervalMs: numericOption(env.TOKEMPERATURE_INTERVAL_MS, '采集间隔', 300000, 15000, 86400000),
    watch: env.TOKEMPERATURE_WATCH !== '0',
    wsl: env.TOKEMPERATURE_WSL === '1',
    stateDir: path.resolve(ROOT, env.TOKEMPERATURE_STATE_DIR || '.data'),
    since
  };
}

function exportData(stats, history) {
  const periods = Object.fromEntries(Object.entries(stats.periods).map(([key, { sessions, ...period }]) => [key, period]));
  return { periods, history };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: npm start [-- --port 17322] 或 npm run demo');
    return;
  }
  process.chdir(ROOT);
  if (!args.demo) loadDotEnv();
  const config = readConfig(args, process.env);
  const toolSettings = createToolSettings({
    defaults: config.clients,
    file: config.demo ? undefined : path.join(config.stateDir, 'tools.json')
  });
  const thermostatSettings = createThermostatSettings({
    file: config.demo ? undefined : path.join(config.stateDir, 'thermostat.json')
  });
  const { clients } = toolSettings.get();
  const dailyProjects = config.demo ? undefined : createDailyProjects(path.join(config.stateDir, 'daily-projects'));
  const dashboard = createDashboard({ ...config, mode: config.demo ? 'demo' : 'local', clients, dailyProjects });
  let hub;
  let demo;
  let collection;
  let rates;
  if (config.demo) {
    demo = require('./demo').demoData();
    dashboard.replace(demo.stats, demo.history, demo.record);
    dashboard.seedBurnHistory(demo.burnSamples);
  } else {
    process.env.TOKEN_MONITOR_SHARED_DIR = config.stateDir;
    process.env.TOKSCALE_CONFIG_DIR ||= path.join(config.stateDir, 'tokscale');
    const { createHub } = require('../hub/server');
    const { createOutboundFetch } = require('../shared/outboundFetch');
    rates = createCnyRateCache({
      file: path.join(config.stateDir, 'exchange-rates.json'),
      fetchImpl: (url, options) => createOutboundFetch()(url, options),
      onChange: dashboard.setCnyQuote
    });
    dashboard.setCnyQuote(rates.get());
    hub = createHub({ dataFile: path.join(config.stateDir, 'devices.json') });
    const saved = hub.getDevices().find(device => device.deviceId === config.deviceId);
    if (saved) dashboard.replace(hub.getStats(), hub.getHistory(), saved, { restored: true });
    collection = createCollectionController({
      dashboard,
      prepare: () => require('../../scripts/ensure-vendored-tokscale').ensureVendoredTokscale(),
      start: selected => require('./collector').startUsageCollection({ config: { ...config, clients: selected }, hub, dashboard })
    });
  }

  const web = createWebServer({
    dashboard,
    toolSettings,
    thermostatSettings,
    onToolsChanged(selected) {
      if (collection) collection.configure(selected);
      else dashboard.setClients(selected);
    },
    getExport() {
      if (demo) return exportData(demo.stats, demo.history);
      if (dashboard.status().lastSuccessAt) return exportData(hub.getStats(), hub.getHistory());
      return null;
    }
  });
  const url = await web.start(config.port);
  console.log(`Tokemperature ${config.demo ? '演示' : '本机用量'} ${url}`);

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    rates?.stop();
    try {
      await Promise.all([web.stop(), collection?.stop()]);
    } finally {
      await hub?.stop();
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => stop().catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    }));
  }
  rates?.start();
  await collection?.configure(clients);
}

if (require.main === module) main().catch(error => {
  console.error(`Tokemperature 启动失败${error.code === 'EADDRINUSE' ? '，端口已被占用' : ''}。`, error.message);
  process.exitCode = 1;
});

module.exports = { readConfig };
