# velora-express

Fast, dependency-light Express utilities for production APIs. `velora-express` gives you the pieces most teams keep rebuilding: async route handling, RFC problem details, request context, validation adapters, security headers, in-memory cache, ETags, idempotency, rate limits, deadlines, circuit breakers, metrics, safe JSON, stable hashing, and response helpers.

Runtime dependencies: **zero**. Express is a peer dependency.

## Install

```bash
npm install velora-express express
```

## Quick Start

```js
import express from 'express';
import {
  asyncHandler,
  problemDetails,
  requestContext,
  securityHeaders,
  smartJson
} from 'velora-express';

const app = express();

app.use(express.json());
app.use(requestContext());
app.use(securityHeaders());
app.use(smartJson());

app.get('/health', asyncHandler(async (_req, res) => {
  res.ok({ status: 'up' });
}));

app.use(problemDetails());
app.listen(3000);
```

## What Is Included

| Feature | Export | Purpose |
| --- | --- | --- |
| Async routes | `asyncHandler` | Catches rejected promises and forwards them to Express error handling. |
| Typed API errors | `ApiError` | Adds status, code, exposed details, headers, and RFC problem conversion. |
| Problem details | `problemDetails`, `makeProblem` | Sends `application/problem+json` compatible errors. |
| Request context | `requestContext`, `getRequestContext`, `contextValue` | Per-request storage powered by `AsyncLocalStorage`. |
| Validation | `validate`, `validateRequest` | Works with Zod-like `safeParse`, parser objects, or plain functions. |
| Security headers | `securityHeaders` | Applies strict default browser security headers. |
| Rate limits | `rateLimit`, `createMemoryRateLimitStore` | Fast fixed-window limiter with pluggable storage. |
| Idempotency | `idempotency` | Replays successful mutation responses by idempotency key. |
| HTTP cache | `httpCache`, `LruTtlStore` | In-memory GET/HEAD response cache with TTL and LRU eviction. |
| ETags | `etag` | Generates weak or strong ETags and handles `If-None-Match`. |
| Deadlines | `deadline`, `withTimeout` | Fails slow HTTP or internal async work with timeout errors. |
| Resilience | `createCircuitBreaker` | Opens after repeated failures and recovers after a reset window. |
| Route builder | `createRoute` | Composes validation, rate limits, cache, and async handling. |
| Response helpers | `smartJson` | Adds `res.ok`, `res.created`, `res.accepted`, `res.noContent`, and `res.problem`. |
| Metrics | `metrics` | Emits request timing, status, route, and request id to your sink. |
| Utilities | `safeJson`, `stableHash`, `constantTimeEqual`, `clientIp` | Production-safe primitives for logs, signatures, and networking. |

## Middleware Order

Recommended order:

```js
app.use(express.json());
app.use(requestContext());
app.use(securityHeaders());
app.use(metrics({ sink: console.log }));
app.use(smartJson());

// routes

app.use(problemDetails());
```

`problemDetails()` should be registered after routes because it is an Express error middleware.

## Validation

`validateRequest()` intentionally supports multiple validator styles instead of locking you into one dependency.

```js
const createUser = {
  safeParse(value) {
    if (typeof value.email === 'string') return { success: true, data: value };
    return { success: false, error: { issues: [{ path: ['email'], message: 'Required' }] } };
  }
};

app.post('/users', validateRequest({ body: createUser }), asyncHandler(async (req, res) => {
  res.created({ user: req.body });
}));
```

## Rate Limiting

```js
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 120,
  key: (req) => req.user?.id || req.ip
}));
```

For distributed systems, pass a custom store implementing `hit(key)`.

## Idempotency

```js
app.post('/payments', idempotency(), asyncHandler(async (_req, res) => {
  res.created({ paymentId: 'pay_123' });
}));
```

Clients send:

```http
Idempotency-Key: unique-client-token
```

Successful `POST`, `PATCH`, and `PUT` responses are cached and replayed with `idempotency-replayed: true`.

## Caching And ETags

```js
app.get('/catalog', etag(), httpCache({ ttlMs: 15_000 }), asyncHandler(async (_req, res) => {
  res.json(await loadCatalog());
}));
```

Use `LruTtlStore` directly when you need a tiny in-process cache:

```js
const store = new LruTtlStore({ max: 500, ttlMs: 30_000 });
store.set('feature-flags', flags);
```

## Deadlines And Circuit Breakers

```js
const billingBreaker = createCircuitBreaker({ failureThreshold: 3, resetAfterMs: 10_000 });

app.get('/invoice/:id', deadline({ timeoutMs: 2500 }), asyncHandler(async (req, res) => {
  const invoice = await billingBreaker.exec(() =>
    withTimeout(() => billing.getInvoice(req.params.id), 2000)
  );

  res.ok(invoice);
}));
```

## Request Context

```js
app.use(requestContext({ header: 'x-request-id' }));

app.use((req, _res, next) => {
  contextValue('userId', req.user?.id);
  next();
});

logger.info({
  requestId: getRequestContext()?.requestId,
  userId: contextValue('userId')
});
```

## Response Helpers

`smartJson()` adds helpers without hiding Express:

```js
res.ok(data, meta);       // 200 { ok: true, data, meta }
res.created(data);        // 201
res.accepted(data);       // 202
res.noContent();          // 204
res.problem(409, 'Duplicate email', { code: 'EMAIL_EXISTS' });
```

## TypeScript

The package ships TypeScript declarations. To type the `smartJson()` response helpers globally, add this in your app:

```ts
declare global {
  namespace Express {
    interface Response {
      ok(data: unknown, meta?: unknown): this;
      created(data: unknown, meta?: unknown): this;
      accepted(data: unknown, meta?: unknown): this;
      noContent(): this;
      problem(status: number, title: string, extras?: unknown): this;
    }
  }
}
```

## Performance Notes

- No required runtime dependencies.
- Middleware is allocation-conscious and avoids global mutation.
- Caches use `Map` insertion order for O(1) LRU-style eviction.
- Request context uses Node's native `AsyncLocalStorage`.
- Hashing and constant-time comparison use Node core crypto primitives.

## Publishing Checklist

```bash
npm test
npm run build
npm pack --dry-run
npm publish --access public
```

You must be logged in with `npm login` before publishing.

## License

MIT
