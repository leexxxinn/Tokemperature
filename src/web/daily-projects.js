'use strict';

const path = require('node:path');
const { readJson, writeJsonAtomic } = require('../shared/config');

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function createDailyProjects(directory) {
  let lastDate;
  let lastEntry;
  let lastSignature;
  const fileFor = date => path.join(directory, `${date}.json`);

  return {
    get(date, timeZone) {
      if (!isCalendarDate(date)) return null;
      const row = date === lastDate ? lastEntry : readJson(fileFor(date), null);
      return row?.timeZone === timeZone && Array.isArray(row.projects) ? row : null;
    },
    capture(date, entry) {
      if (!isCalendarDate(date)) return;
      const signature = JSON.stringify(entry);
      if (date === lastDate && signature === lastSignature) return;
      writeJsonAtomic(fileFor(date), entry, 0);
      lastDate = date;
      lastEntry = entry;
      lastSignature = signature;
    }
  };
}

module.exports = { createDailyProjects, isCalendarDate };
