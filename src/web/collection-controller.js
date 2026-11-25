'use strict';

function createCollectionController({ dashboard, prepare, start, logger = console }) {
  let ready = false;
  let closed = false;
  let generation = 0;
  let stopActive;
  let pending = Promise.resolve();

  function schedule(clients) {
    const requested = ++generation;
    pending = pending.then(async () => {
      if (requested !== generation) return;
      const previous = stopActive;
      stopActive = undefined;
      await previous?.();
      if (closed || requested !== generation || !clients.length) return;
      if (!ready) {
        await prepare();
        ready = true;
      }
      if (!closed && requested === generation) stopActive = start(clients);
    }).catch(error => {
      logger.error('采集器配置更新失败。', error.message);
      if (!closed && requested === generation) dashboard.fail('scanner-unavailable');
    });
    return pending;
  }

  return {
    configure(clients) {
      if (closed) return pending;
      dashboard.setClients(clients);
      return schedule(clients);
    },
    stop() {
      if (closed) return pending;
      closed = true;
      return schedule([]);
    }
  };
}

module.exports = { createCollectionController };
