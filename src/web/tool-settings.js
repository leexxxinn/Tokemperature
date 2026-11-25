'use strict';

const fs = require('node:fs');
const { CLIENT_IDS, KNOWN_CLIENT_LIST } = require('../shared/clientCatalog');
const { writeJsonAtomic } = require('../shared/config');

const known = new Set(CLIENT_IDS);

function validClients(clients) {
  return Array.isArray(clients) && clients.length <= known.size
    && clients.every(id => known.has(id)) && new Set(clients).size === clients.length;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function createToolSettings({ defaults, file }) {
  let settings = { revision: 0, clients: [...defaults] };
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!validRevision(saved?.revision) || !validClients(saved?.clients)) throw new Error('工具设置格式无效');
      settings = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function get() {
    return { revision: settings.revision, clients: [...settings.clients], tools: KNOWN_CLIENT_LIST };
  }

  function update(next) {
    if (!validRevision(next?.revision) || !validClients(next?.clients)) return { error: 'invalid_tools' };
    if (next.revision !== settings.revision) return { error: 'settings_conflict' };
    const current = new Set(settings.clients);
    if (next.clients.length === current.size && next.clients.every(id => current.has(id))) {
      return { changed: false, settings: get() };
    }
    const updated = { revision: settings.revision + 1, clients: [...next.clients] };
    if (file) writeJsonAtomic(file, updated);
    settings = updated;
    return { changed: true, settings: get() };
  }

  return { get, update };
}

module.exports = { createToolSettings };
