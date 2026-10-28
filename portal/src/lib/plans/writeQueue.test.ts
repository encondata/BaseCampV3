/**
 * lib/plans/writeQueue.ts: the plan tab's writes run one at a time, in the
 * order asked, so each sends the version the one before it answered.
 */
import { describe, expect, it } from 'vitest';

import { WriteQueue } from './writeQueue';

function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('WriteQueue', () => {
  it('starts a job only once the one before it has finished', async () => {
    const queue = new WriteQueue();
    const first = deferred<string>();
    const started: string[] = [];
    const one = queue.run(async () => { started.push('one'); return first.promise; });
    const two = queue.run(async () => { started.push('two'); return 'two'; });
    await settle();
    expect(started).toEqual(['one']);
    first.resolve('one');
    expect(await one).toBe('one');
    expect(await two).toBe('two');
    expect(started).toEqual(['one', 'two']);
  });

  it('runs the next job after one that failed, and hands the failure to its caller', async () => {
    const queue = new WriteQueue();
    const boom = new Error('boom');
    const one = queue.run(async () => { throw boom; });
    const two = queue.run(async () => 'two');
    await expect(one).rejects.toBe(boom);
    expect(await two).toBe('two');
  });

  it('keeps the order jobs were queued in', async () => {
    const queue = new WriteQueue();
    const order: number[] = [];
    const slow = deferred<void>();
    const jobs = [
      queue.run(async () => { await slow.promise; order.push(1); }),
      queue.run(async () => { order.push(2); }),
      queue.run(async () => { order.push(3); }),
    ];
    slow.resolve();
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
  });
});
