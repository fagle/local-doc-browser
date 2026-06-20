export function createKeyedTaskQueue({ concurrency = 2 } = {}) {
  const maxConcurrency = Math.max(1, Math.floor(concurrency) || 1);
  const inFlight = new Map();
  const queue = [];
  let activeCount = 0;
  let sequence = 0;

  function pump() {
    while (activeCount < maxConcurrency && queue.length > 0) {
      queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      const job = queue.shift();
      const record = inFlight.get(job.key);
      if (record) record.job = null;
      activeCount += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeCount -= 1;
          inFlight.delete(job.key);
          pump();
        });
    }
  }

  function cancel(key, reason = "task cancelled") {
    const taskKey = String(key);
    const record = inFlight.get(taskKey);
    if (!record?.job) return false;
    const index = queue.indexOf(record.job);
    if (index >= 0) queue.splice(index, 1);
    inFlight.delete(taskKey);
    record.job.reject(new Error(reason));
    return true;
  }

  function run(key, task, options = {}) {
    const taskKey = String(key);
    const existing = inFlight.get(taskKey);
    if (existing) {
      if (existing.job) {
        existing.job.priority = Math.max(existing.job.priority, Number(options.priority || 0));
      }
      return existing.promise;
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const job = {
      key: taskKey,
      priority: Number(options.priority || 0),
      reject: rejectPromise,
      resolve: resolvePromise,
      sequence: sequence += 1,
      task,
    };
    inFlight.set(taskKey, { job, promise });
    queue.push(job);
    pump();
    return promise;
  }

  return {
    get activeCount() {
      return activeCount;
    },
    get pendingCount() {
      return queue.length;
    },
    run,
    cancel,
  };
}
