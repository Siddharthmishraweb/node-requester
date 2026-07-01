# velora-express

Fast, dependency-light Express utilities for production APIs. `velora-express` gives you the pieces most teams keep rebuilding: async route handling, RFC problem details, request context, validation adapters, security headers, in-memory cache, ETags, idempotency, rate limits, deadlines, circuit breakers, metrics, safe JSON, stable hashing, and response helpers.

Runtime dependencies: **zero**. Express is a peer dependency.

Version `1.1.0` also includes an AM92-style compatibility layer: `CustomError`, `ResponseBody`, `configureApp`, `configureRouter`, `asyncWrapper`, `httpContext`, `apiLogging`, `extractHeaders`, `routeSanity`, `handleResponse`, `handleError`, `decryptCryptoKey`, `decryptPayload`, and `encryptPayload`.

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

## AM92-Style Stable Response Flow

Use this when you want every route to return the same envelope shape:

```js
import express from 'express';
import {
  ResponseBody,
  CustomError,
  configureRouter,
  configureApp
} from 'velora-express';

const app = express();
const router = express.Router();

configureRouter(router, {
  routerName: 'users',
  enabled: true,
  disableCrypto: true,
  routesConfig: {
    listUsers: {
      method: 'get',
      path: '/users',
      enabled: true,
      cache: { ttlMs: 10_000 },
      pipeline: [
        async (_req, res) => {
          res.body = new ResponseBody(200, 'Success', [{ id: 1 }]);
        }
      ]
    },
    createUser: {
      method: 'post',
      path: '/users',
      enabled: true,
      pipeline: [
        async (req, res) => {
          if (!req.body.email) {
            throw new CustomError(new Error('Email required'), {
              statusCode: 422,
              errorCode: 'USER_EMAIL_REQUIRED'
            });
          }

          res.body = new ResponseBody(201, 'Created', { id: 1 });
        }
      ]
    }
  }
});

configureApp(app, [{ path: '/api', router }]);
```

All responses keep this structure:

```json
{
  "statusCode": 200,
  "status": "OK",
  "message": "Success",
  "data": {},
  "error": null,
  "errorCode": null
}
```

Errors use the same structure, so clients do not need a separate parser for failures.

## AM92-Compatible Exports

- `ResponseBody`: stable response envelope.
- `CustomError`: app error wrapper with `statusCode`, `errorCode`, `data`, and original `error`.
- `configureApp`: installs request context, header extraction, security, logging, default routes, final response handling, and error handling.
- `configureRouter`: builds routes from config with pre, main, post, crypto, cache, rate-limit, and validation pipelines.
- `asyncWrapper` / `asyncHandler`: forwards async errors to Express.
- `httpContext`: request-scoped storage with helpers for request id, session id, client id, and encryption keys.
- `apiLogging` and `logManager`: structured request/response logging with body redaction and body-log opt out.
- `extractHeaders`: stores lowercase request headers and generates missing request/session ids.
- `routeSanity`: marks matched routes so unmatched routes return a stable 404 envelope.
- `handleResponse`: sends `ResponseBody` or redirects for 3xx bodies.
- `handleError`: wraps all errors into `CustomError` and returns a stable `ResponseBody`.
- `decryptCryptoKey`, `decryptPayload`, `encryptPayload`: optional crypto hooks with pluggable crypto providers.

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

## Route-Level Response Caching

`configureRouter()` supports cache config per route:

```js
configureRouter(router, {
  enabled: true,
  disableCrypto: true,
  routesConfig: {
    catalog: {
      method: 'get',
      path: '/catalog',
      enabled: true,
      cache: {
        ttlMs: 30_000,
        key: (req) => `catalog:${req.headers['accept-language'] || 'en'}`
      },
      pipeline: [
        async (_req, res) => {
          res.body = new ResponseBody(200, 'Success', await loadCatalog());
        }
      ]
    }
  }
});
```

For lower-level Express handlers, use `responseCache()` or `httpCache()`. Both use `LruTtlStore` by default and accept a custom store.

## Optional Payload Crypto

Velora does not force a crypto dependency. You can provide your own provider:

```js
import { initialize } from 'velora-express';

await initialize({
  validateClient: async (clientId) => Boolean(clientId),
  crypto: {
    async decryptKey(clientId, encryptedKey) {
      return unwrapClientKey(clientId, encryptedKey);
    },
    encryptData(value, key) {
      return encrypt(value, key);
    },
    decryptData(payload, key) {
      return decrypt(payload, key);
    }
  }
});
```

If no provider is supplied, `createPayloadCrypto()` gives you a small AES-256-GCM helper suitable for internal services and tests.

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
- Logging redacts sensitive keys by default.
- Route configuration composes only the middleware a route enables.

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
