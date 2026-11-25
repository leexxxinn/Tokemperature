'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { renderSnapshotCsv, renderTimeseriesCsv, renderDailyModelsCsv, renderExportJson } = require('../shared/exporter');
const { readJsonBody } = require('../shared/http');
const { isCalendarDate } = require('./daily-projects');
const { version } = require('../../package.json');

const HOST = '127.0.0.1';
const PUBLIC = path.resolve(__dirname, 'public');
const VENDOR_THREE_DIR = path.resolve(PUBLIC, 'vendor', 'three');
const VENDOR_THREE_PATH = /^\/vendor\/three\/[a-zA-Z0-9._/-]+\.js$/;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/token-format.js', ['token-format.js', 'text/javascript; charset=utf-8']],
  ['/cost-format.js', ['cost-format.js', 'text/javascript; charset=utf-8']],
  ['/thermal.js', ['thermal.js', 'text/javascript; charset=utf-8']],
  ['/crucible-scene.js', ['crucible-scene.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/tools.js', ['tools.js', 'text/javascript; charset=utf-8']],
  ['/thermostat.js', ['thermostat.js', 'text/javascript; charset=utf-8']],
  ['/client-catalog.js', ['../../shared/clientCatalog.js', 'text/javascript; charset=utf-8']],
  ['/assets/crucible-reactor.glb', ['assets/crucible-reactor.glb', 'model/gltf-binary']],
  ['/assets/crucible-fallback.png', ['assets/crucible-fallback.png', 'image/png']]
]);

function createWebServer({ dashboard, getExport, toolSettings, onToolsChanged, thermostatSettings, onThermostatChanged }) {
  const streams = new Set();
  const send = (req, res, body, type, code = 200) => {
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const json = (req, res, body, code) => send(req, res, JSON.stringify(body), 'application/json; charset=utf-8', code);

  async function handleSettingsEndpoint(req, res, host, settings, onChanged) {
    if (req.method === 'PUT') {
      if (req.headers.origin !== `http://${host}`) return json(req, res, { error: 'invalid_origin' }, 403);
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(req, res, { error: 'invalid_content_type' }, 415);
      }
      let body;
      try {
        body = await readJsonBody(req, 4096);
      } catch (error) {
        if (res.destroyed) return;
        return error.code === 'payload_too_large'
          ? json(req, res, { error: error.code }, 413)
          : json(req, res, { error: 'invalid_json' }, 400);
      }
      const result = settings.update(body);
      if (result.error) return json(req, res, { error: result.error }, result.error === 'settings_conflict' ? 409 : 400);
      if (result.changed) onChanged?.(result.settings);
      return json(req, res, result.settings);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD, PUT');
      return json(req, res, { error: 'method_not_allowed' }, 405);
    }
    return json(req, res, settings.get());
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const port = server.address()?.port;
    const host = req.headers.host?.toLowerCase();
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}` && !(port === 80 && [HOST, 'localhost'].includes(host))) {
      return json(req, res, { error: 'invalid_host' }, 403);
    }
    try {
      const url = new URL(req.url, `http://${HOST}`);
      if (url.pathname === '/api/v1/tools' && toolSettings) {
        return await handleSettingsEndpoint(req, res, host, toolSettings, next => onToolsChanged?.(next.clients));
      }
      if (url.pathname === '/api/v1/thermostat' && thermostatSettings) {
        return await handleSettingsEndpoint(req, res, host, thermostatSettings, next => onThermostatChanged?.(next));
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(req, res, { error: 'method_not_allowed' }, 405);
      }
      const asset = ASSETS.get(url.pathname);
      if (asset) return send(req, res, fs.readFileSync(path.join(PUBLIC, asset[0])), asset[1]);
      if (VENDOR_THREE_PATH.test(url.pathname) && !url.pathname.includes('..')) {
        const rel = url.pathname.slice('/vendor/three/'.length);
        const target = path.resolve(VENDOR_THREE_DIR, rel);
        if (target.startsWith(VENDOR_THREE_DIR + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
          return send(req, res, fs.readFileSync(target), 'text/javascript; charset=utf-8');
        }
      }
      if (url.pathname === '/api/v1/summary') return json(req, res, dashboard.summary());
      if (url.pathname === '/api/v1/status') return json(req, res, dashboard.status());
      if (url.pathname === '/api/v1/history') {
        const days = Number(url.searchParams.get('days') ?? '30');
        if (![7, 30, 90].includes(days)) return json(req, res, { error: 'invalid_days' }, 400);
        return json(req, res, dashboard.history(days));
      }
      if (url.pathname === '/api/v1/distribution') {
        const date = url.searchParams.get('date');
        if (!isCalendarDate(date)) return json(req, res, { error: 'invalid_date' }, 400);
        return json(req, res, dashboard.distribution(date));
      }
      if (url.pathname === '/api/v1/events' && req.method === 'GET') {
        if (streams.size >= 32) return json(req, res, { error: 'too_many_streams' }, 503);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        streams.add(res);
        const write = chunk => { if (!res.destroyed && !res.write(chunk)) res.destroy(); };
        const update = status => write(`data: ${JSON.stringify({ revision: status.revision })}\n\n`);
        const unsubscribe = dashboard.subscribe(update);
        const heartbeat = setInterval(() => write(': heartbeat\n\n'), 25000);
        heartbeat.unref();
        res.once('close', () => {
          unsubscribe();
          clearInterval(heartbeat);
          streams.delete(res);
        });
        write('retry: 5000\n\n');
        update(dashboard.status());
        return;
      }
      if (url.pathname === '/api/v1/export') {
        const format = url.searchParams.get('format') || 'csv';
        const scope = url.searchParams.get('scope') || 'snapshot';
        if (!['csv', 'json'].includes(format) || !['snapshot', 'daily', 'models'].includes(scope)) {
          return json(req, res, { error: 'invalid_export' }, 400);
        }
        const data = getExport();
        if (!data) return json(req, res, { error: 'no_data' }, 409);
        const filename = format === 'json' ? 'export.json' : `${scope === 'models' ? 'daily-models' : scope}.csv`;
        res.setHeader('Content-Disposition', `attachment; filename="tokemperature-${filename}"`);
        if (format === 'json') return send(req, res, renderExportJson({ ...data, meta: { app: { name: 'tokemperature', version } } }), 'application/json; charset=utf-8');
        const render = { snapshot: renderSnapshotCsv, daily: renderTimeseriesCsv, models: renderDailyModelsCsv }[scope];
        return send(req, res, render(scope === 'snapshot' ? data.periods : data.history), 'text/csv; charset=utf-8');
      }
      return json(req, res, { error: 'not_found' }, 404);
    } catch (error) {
      console.error('Web 服务请求失败', error.message);
      return json(req, res, { error: 'internal_error' }, 500);
    }
  });
  return {
    server,
    start(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          resolve(`http://${HOST}:${server.address().port}`);
        });
      });
    },
    stop() {
      for (const stream of streams) stream.end();
      return new Promise((resolve, reject) => server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }));
    }
  };
}

module.exports = { createWebServer };
