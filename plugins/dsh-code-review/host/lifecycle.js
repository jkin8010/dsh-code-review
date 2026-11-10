/**
 * Own the plugin's asynchronous startup and disposal in one place.
 *
 * The lifecycle effect returns immediately while initialization continues, so
 * disposal must await the in-flight init before tearing services down and
 * flushing the store; otherwise a slow start could write after teardown or lose
 * the last flush. Timers are created only after initialization succeeds.
 */
export function startLifecycle({
  config, store, jobs, snapshot, serviceRefs, logger,
}) {
  let disposed = false;
  let flushTimer = null;
  let pruneTimer = null;

  const init = (async () => {
    await store.init();
    if (disposed) return;
    await jobs.init();
    if (disposed) return;
    await snapshot.init();
    if (disposed) return;
    flushTimer = setInterval(() => {
      void store.flush();
    }, 15_000);
    flushTimer.unref?.();
    pruneTimer = setInterval(() => {
      try {
        jobs.prune();
      } catch (error) {
        logger.warn(`prune failed: ${error.message ?? error}`);
      }
    }, 60_000);
    pruneTimer.unref?.();
    logger.info(`code review studio ready (${config.stateDir}, ocr=${config.ocr.bin || 'missing'})`);
  })().catch((error) => {
    logger.error(`code review studio failed to start: ${error?.message ?? error}`);
  });

  return async function disposeLifecycle() {
    if (disposed) return;
    disposed = true;
    if (flushTimer) clearInterval(flushTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    await init;
    try {
      jobs.dispose();
    } catch {
      /* disposal is best effort */
    }
    try {
      snapshot.dispose();
    } catch {
      /* disposal is best effort */
    }
    serviceRefs.dispose();
    try {
      await store.flush();
    } catch {
      /* a failed final flush must not throw from teardown */
    }
  };
}
