import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageQuota, estimateJsonBytes, QuotaError } from '../dist/esm/index.js';

test('plans and explicitly commits lowest-priority eviction first', () => {
  const quota = createStorageQuota(100, [
    { id: 'low-old', bytes: 40, priority: 1, lastUsed: 1 },
    { id: 'low-new', bytes: 30, priority: 1, lastUsed: 2 },
    { id: 'high', bytes: 20, priority: 5, lastUsed: 0 },
  ]);
  const plan = quota.planAdmission({ id: 'critical', bytes: 60, priority: 5 });
  assert.deepEqual(plan.evictIds, ['low-old', 'low-new']);
  assert.equal(quota.snapshot().used, 90);
  const result = quota.commit(plan);
  assert.equal(result.used, 80);
  assert.equal(
    result.entries.some((entry) => entry.id === 'high'),
    true,
  );
});

test('uses entry id as deterministic tie breaker', () => {
  const quota = createStorageQuota(10, [
    { id: 'b', bytes: 4, priority: 1 },
    { id: 'a', bytes: 4, priority: 1 },
  ]);
  assert.deepEqual(quota.planAdmission({ id: 'new', bytes: 7, priority: 1 }).evictIds, ['a', 'b']);
});

test('protects pinned and higher priority entries and reports rejection reason', () => {
  const quota = createStorageQuota(10, [
    { id: 'pinned', bytes: 6, priority: 0, pinned: true },
    { id: 'important', bytes: 4, priority: 9 },
  ]);
  const plan = quota.planAdmission({ id: 'candidate', bytes: 5, priority: 1 });
  assert.equal(plan.accepted, false);
  assert.equal(plan.reason, 'protected');
  assert.throws(() => quota.commit(plan), { code: 'capacity' });
});

test('replaces an existing entry without counting it against itself', () => {
  const quota = createStorageQuota(10, [{ id: 'same', bytes: 8, priority: 1 }]);
  const plan = quota.planAdmission({ id: 'same', bytes: 9, priority: 1 });
  assert.equal(plan.accepted, true);
  assert.deepEqual(plan.evictIds, []);
  assert.equal(quota.commit(plan).used, 9);
  assert.equal(quota.snapshot().entries.length, 1);
});

test('does not silently unpin a protected entry during replacement', () => {
  const quota = createStorageQuota(10, [{ id: 'pinned', bytes: 4, priority: 1, pinned: true }]);
  const plan = quota.planAdmission({ id: 'pinned', bytes: 5, priority: 1 });
  assert.equal(plan.accepted, false);
  assert.equal(plan.reason, 'protected');
  assert.equal(quota.snapshot().used, 4);
});

test('rejects stale plans after a commit or removal', () => {
  const quota = createStorageQuota(10);
  const first = quota.planAdmission({ id: 'a', bytes: 2, priority: 0 });
  const stale = quota.planAdmission({ id: 'b', bytes: 2, priority: 0 });
  quota.commit(first);
  assert.throws(() => quota.commit(stale), { code: 'stale-plan' });
  quota.remove('a');
  assert.equal(quota.snapshot().used, 0);
});

test('rejects plans from another manager', () => {
  const a = createStorageQuota(10);
  const b = createStorageQuota(10);
  const plan = a.planAdmission({ id: 'a', bytes: 1, priority: 0 });
  assert.throws(() => b.commit(plan), { code: 'foreign-plan' });
});

test('rejects candidate larger than capacity without mutation', () => {
  const quota = createStorageQuota(5);
  const plan = quota.planAdmission({ id: 'large', bytes: 6, priority: 1 });
  assert.equal(plan.accepted, false);
  assert.equal(plan.reason, 'capacity');
  assert.equal(quota.snapshot().used, 0);
});

test('enforces entry, identifier, priority, and initial-capacity validation', () => {
  assert.throws(
    () =>
      createStorageQuota(10, [
        { id: 'a', bytes: 8, priority: 0 },
        {
          id: 'b',
          bytes: 8,
          priority: 0,
        },
      ]),
    { code: 'capacity' },
  );
  assert.throws(() => createStorageQuota(10, [{ id: '', bytes: 1, priority: 0 }]), {
    code: 'invalid',
  });
  assert.throws(() => createStorageQuota(10, [], { maxEntries: 0 }), RangeError);
  const quota = createStorageQuota(10, [], { maxEntries: 1 });
  quota.commit(quota.planAdmission({ id: 'one', bytes: 1, priority: 1 }));
  assert.equal(quota.planAdmission({ id: 'two', bytes: 1, priority: 1 }).accepted, false);
});

test('estimates UTF-8 JSON bytes and enforces the estimator bound', () => {
  assert.equal(estimateJsonBytes({ x: 'é' }), new TextEncoder().encode('{"x":"é"}').byteLength);
  assert.throws(() => estimateJsonBytes({ x: 'long' }, 3), { code: 'capacity' });
  assert.throws(() => estimateJsonBytes(undefined), { code: 'invalid' });
  assert.throws(() => estimateJsonBytes(1, -1), { code: 'invalid' });
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      return 1;
    },
  });
  assert.throws(() => estimateJsonBytes(accessor), { code: 'invalid' });
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => estimateJsonBytes(sparse), { code: 'invalid' });
});

test('snapshots are frozen copies and remove reports exact existence', () => {
  const quota = createStorageQuota(10, [{ id: 'x', bytes: 4, priority: 2 }]);
  const snapshot = quota.snapshot();
  assert.equal(Object.isFrozen(snapshot.entries), true);
  assert.equal(Object.isFrozen(snapshot.entries[0]), true);
  assert.equal(quota.remove('x'), true);
  assert.equal(quota.remove('x'), false);
  assert.equal(quota.snapshot().available, 10);
});

test('rejects malformed values and noninteger accounting units', () => {
  assert.throws(() => createStorageQuota(-1), { code: 'invalid' });
  const quota = createStorageQuota(10);
  assert.throws(() => quota.planAdmission({ id: 'x', bytes: 1.5, priority: 0 }), {
    code: 'invalid',
  });
  assert.throws(() => quota.planAdmission({ id: 'x', bytes: 1, priority: -1 }), QuotaError);
});
