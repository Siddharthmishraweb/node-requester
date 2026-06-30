import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  LruTtlStore,
  createCircuitBreaker,
  createMemoryRateLimitStore,
  makeProblem,
  safeJson,
  validate,
  withTimeout
} from '../src/index.js';

test('ApiError exposes problem details', () => {
  const err = new ApiError(422, 'Bad payload', { code: 'BAD_PAYLOAD', detail: { field: 'email' } });
  assert.equal(err.status, 422);
  assert.equal(err.toProblem('/users').type, 'https://httpstatuses.com/422');
  assert.deepEqual(err.toProblem('/users').detail, { field: 'email' });
});

test('safeJson handles circular structures', () => {
  const value = { ok: true };
  value.self = value;
  const parsed = JSON.parse(safeJson(value));
  assert.equal(parsed.self, '[Circular]');
});

test('LruTtlStore expires and evicts', async () => {
  const store = new LruTtlStore({ max: 1, ttlMs: 25 });
  store.set('a', 1);
  store.set('b', 2);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('b'), 2);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(store.get('b'), undefined);
});

test('rate limit store calculates retry windows', () => {
  const store = createMemoryRateLimitStore({ windowMs: 1000, limit: 2 });
  assert.equal(store.hit('ip').allowed, true);
  assert.equal(store.hit('ip').allowed, true);
  const third = store.hit('ip');
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.ok(third.retryAfterMs > 0);
});

test('validate supports standard-schema style parse results', () => {
  const schema = {
    safeParse(value) {
      return value.name ? { success: true, data: value } : { success: false, error: { issues: ['name required'] } };
    }
  };
  assert.deepEqual(validate(schema, { name: 'Ada' }), { name: 'Ada' });
  assert.throws(() => validate(schema, {}), ApiError);
});

test('withTimeout rejects slow work', async () => {
  await assert.rejects(
    withTimeout(() => new Promise((resolve) => setTimeout(resolve, 50)), 5),
    /timed out/
  );
});

test('circuit breaker opens after failures', async () => {
  const breaker = createCircuitBreaker({ failureThreshold: 2, resetAfterMs: 5000 });
  await assert.rejects(breaker.exec(async () => { throw new Error('boom'); }));
  await assert.rejects(breaker.exec(async () => { throw new Error('boom'); }));
  await assert.rejects(breaker.exec(async () => 'ok'), /Circuit is open/);
});

test('makeProblem creates RFC 9457 compatible shape', () => {
  const problem = makeProblem(404, 'Missing', { instance: '/missing', code: 'NOPE' });
  assert.equal(problem.status, 404);
  assert.equal(problem.title, 'Missing');
  assert.equal(problem.code, 'NOPE');
});
