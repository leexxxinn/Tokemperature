'use strict';

const fs = require('node:fs');
const { writeJsonAtomic } = require('../shared/config');

const MODES = new Set(['auto', 'tokens', 'cny', 'usd']);

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeSettingsBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { mode, notify } = input;
  if (!MODES.has(mode) || typeof notify !== 'boolean') return null;
  if (mode === 'auto') {
    if (input.value !== undefined && input.value !== null && (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0)) {
      return null;
    }
    return { mode, value: 0, notify };
  }
  const raw = input.value;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  if (mode === 'tokens') {
    if (!Number.isInteger(raw) || raw > 1e12) return null;
    return { mode, value: raw, notify };
  }
  if (raw > 1e6) return null;
  const rounded = Math.round(raw * 100) / 100;
  if (rounded <= 0) return null;
  return { mode, value: rounded, notify };
}

function createThermostatSettings({ file } = {}) {
  let settings = { revision: 0, mode: 'auto', value: 0, notify: false };
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const normalized = normalizeSettingsBody(saved);
      if (!validRevision(saved?.revision) || !normalized) throw new Error('温控设置格式无效');
      settings = { revision: saved.revision, ...normalized };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function get() {
    return {
      revision: settings.revision,
      mode: settings.mode,
      value: settings.value,
      notify: settings.notify
    };
  }

  function update(next) {
    if (!validRevision(next?.revision)) return { error: 'invalid_thermostat' };
    const normalized = normalizeSettingsBody(next);
    if (!normalized) return { error: 'invalid_thermostat' };
    if (next.revision !== settings.revision) return { error: 'settings_conflict' };
    if (
      normalized.mode === settings.mode
      && normalized.value === settings.value
      && normalized.notify === settings.notify
    ) {
      return { changed: false, settings: get() };
    }
    const updated = { revision: settings.revision + 1, ...normalized };
    if (file) writeJsonAtomic(file, updated);
    settings = updated;
    return { changed: true, settings: get() };
  }

  return { get, update };
}

module.exports = { MODES, createThermostatSettings };
