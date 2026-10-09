import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startQueueWorkers } from './start-queue-workers.js';

test('unset or disabled gates never invoke queue maintenance or status sweeps', () => {
  const forbidden = () => { throw new Error('worker must not start'); };
  for (const gates of [{}, { QUEUE_WORKER_ENABLED: false, WORKFORCE_WORKER_ENABLED: false }]) {
    assert.deepEqual(startQueueWorkers(gates, { queue: forbidden, workforce: forbidden }), { queue: null, workforce: null });
  }
});

test('each gate opts in independently and preserves shutdown callbacks', () => {
  for (const [queue, workforce] of [[true, false], [false, true], [true, true]]) {
    let queues = 0;
    let workforces = 0;
    const queueStop = () => {};
    const workforceStop = () => {};
    const result = startQueueWorkers({ QUEUE_WORKER_ENABLED: queue, WORKFORCE_WORKER_ENABLED: workforce }, {
      queue: () => { queues++; return queueStop; },
      workforce: () => { workforces++; return workforceStop; },
    });
    assert.equal(queues, Number(queue));
    assert.equal(workforces, Number(workforce));
    assert.equal(result.queue, queue ? queueStop : null);
    assert.equal(result.workforce, workforce ? workforceStop : null);
  }
});
