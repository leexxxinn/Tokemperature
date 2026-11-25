'use strict';

const { createUsageRuntime } = require('../shared/usage/usageRuntime');
const { createUsageTransform } = require('../shared/usage/usageTransform');
const { createSessionUsageArchiveStore } = require('../shared/usage/sessionUsageArchiveStore');
const { createCursorUsageEventIndex } = require('../shared/providers/cursor/usageEvents');
const { createDeviceState } = require('../shared/usage/deviceState');
const { syncPayload } = require('../shared/syncPayload');

function startUsageCollection({ config, hub, dashboard, logger = console }) {
  const settings = { clients: config.clients.join(','), sessionUsageArchiveEnabled: true, projectsEnabled: true };
  const store = createSessionUsageArchiveStore({ cursorUsageEvents: createCursorUsageEventIndex() });
  const transform = createUsageTransform({ store, getSettings: () => settings });
  const state = createDeviceState({
    envelope: { deviceId: config.deviceId, agentRuntime: 'headless-agent' },
    onRecord(record) {
      const device = hub.ingest(syncPayload(record));
      dashboard.replace(hub.getStats(), hub.getHistory(), device);
    }
  });

  let runtime;
  try {
    runtime = createUsageRuntime({
      ...settings,
      deviceId: config.deviceId,
      agentRuntime: 'headless-agent',
      allTimeSince: config.since,
      commandTimeoutMs: 120000,
      intervalMs: config.intervalMs,
      watchEnabled: config.watch,
      watchDebounceMs: 1500,
      wslScanEnabled: config.wsl,
      historyEnabled: true,
      historyIntervalMs: 15 * 60 * 1000,
      dailyHistoryArchiveEnabled: true,
      dailyHistoryArchiveWriteEnabled: true,
      anchorPersistenceEnabled: true,
      sessionActivityPolling: true,
      onUpdate(summary, reason) {
        const projected = transform.transform(summary, reason);
        state.updateUsage(projected, reason, { ownsSummary: true });
        return projected;
      },
      onSessionActivity(patch) {
        if (state.updateActivity(patch)) {
          const current = state.getSnapshot();
          if (current) dashboard.updateLiveActivity(current);
        }
      },
      onError(error, reason) {
        logger.error(`采集失败 (${reason})`, error.message);
        dashboard.fail('scan-failed');
      },
      logger: message => logger.log(message)
    });
  } catch (error) {
    store.close();
    throw error;
  }

  return async function stop() {
    state.stop();
    runtime.stop();
    try {
      await runtime.whenIdle();
    } finally {
      store.close();
    }
  };
}

module.exports = { startUsageCollection };
