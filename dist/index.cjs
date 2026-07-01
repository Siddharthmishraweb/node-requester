const { AsyncLocalStorage } = require('node:async_hooks');
const { createCipheriv, createDecipheriv, createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const context = new AsyncLocalStorage();
const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  425: 'Too Early',
  429: 'Too Many Requests',
  499: 'Client Closed Request',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
};
const EXPS_CONST = {
  REQUEST_ID_HEADER_KEY: 'x-req-id',
  SESSION_ID_HEADER_KEY: 'x-session-id',
  CLIENT_ID_HEADER_KEY: 'x-api-client-id',
  ENCRYPTION_KEY_HEADER_KEY: 'x-api-encryption-key',
  PLAINTEXT_ENCRYPTION_KEY: 'plaintext-api-encryption-key',
  RESPONSE_COMPLETED_EVENT: 'velora-express-completed'
};

const SERVICE = `${process.env.npm_package_name || 'velora-express'}@${process.env.npm_package_version || '0.0.0'}`;
const veloraState = {
  initialized: false,
  validateClient: undefined,
  crypto: undefined,
  logger: console
};

class ResponseBody {
  constructor(statusCode = 500, message, data, error, errorCode) {
    this.statusCode = statusCode;
    this.status = STATUS_TEXT[statusCode] || 'Internal Server Error';
    this.message = message || (statusCode && this.status) || 'Unhandled Error';
    this.data = data ?? null;
    this.error = error ?? null;
    this.errorCode = error ? (errorCode || 'Velora::GENERIC') : null;
  }
}

class CustomError extends Error {
  constructor(error, errorMap = {}) {
    if (error?._isCustomError && !Object.keys(errorMap).length) return error;
    super(errorMap.message || error?.message || 'Unhandled Error', { cause: error });
    this.name = 'CustomError';
    this._isCustomError = true;
    this.service = SERVICE;
    this.message = errorMap.message || error?.message || 'Unhandled Error';
    this.statusCode = errorMap.statusCode || error?.statusCode || error?.status || 500;
    this.errorCode = errorMap.errorCode || error?.errorCode || error?.code || 'Velora::GENERIC';
    this.error = error;
    this.data = errorMap.data || error?.data;
  }
}

class ApiError extends Error {
  constructor(status = 500, message = STATUS_TEXT[status] || 'Error', options = {}) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.status = status;
    this.statusCode = status;
    this.code = options.code || `HTTP_${status}`;
    this.errorCode = this.code;
    this.expose = options.expose ?? status < 500;
    this.detail = options.detail;
    this.data = options.data;
    this.headers = options.headers || {};
  }

  toProblem(instance) {
    return makeProblem(this.status, this.expose ? this.message : STATUS_TEXT[this.status] || 'Error', {
      code: this.code,
      detail: this.expose ? this.detail : undefined,
      instance
    });
  }
}

async function initialize(options = {}) {
  veloraState.validateClient = typeof options === 'function' ? options : options.validateClient;
  veloraState.crypto = options.crypto || veloraState.crypto || createPayloadCrypto(options.cryptoSecret);
  veloraState.logger = options.logger || console;
  veloraState.initialized = true;
  veloraState.logger.info?.(`[${SERVICE} VeloraExpress] Initialised`);
}

const ExpressUtils = { initialize };
const asyncWrapper = asyncHandler;

const httpContext = {
  get(key) {
    if (!key) return getRequestContext();
    return contextValue(key);
  },
  set(key, value) {
    return contextValue(key, value);
  },
  getRequestId() {
    return contextValue(`headers.${EXPS_CONST.REQUEST_ID_HEADER_KEY}`);
  },
  setRequestId(value) {
    return contextValue(`headers.${EXPS_CONST.REQUEST_ID_HEADER_KEY}`, value);
  },
  getSessionId() {
    return contextValue(`headers.${EXPS_CONST.SESSION_ID_HEADER_KEY}`);
  },
  setSessionId(value) {
    return contextValue(`headers.${EXPS_CONST.SESSION_ID_HEADER_KEY}`, value);
  },
  getClientId() {
    return contextValue(`headers.${EXPS_CONST.CLIENT_ID_HEADER_KEY}`);
  },
  setClientId(value) {
    return contextValue(`headers.${EXPS_CONST.CLIENT_ID_HEADER_KEY}`, value);
  },
  getEncryptionKey() {
    return contextValue(`headers.${EXPS_CONST.ENCRYPTION_KEY_HEADER_KEY}`);
  },
  setEncryptionKey(value) {
    return contextValue(`headers.${EXPS_CONST.ENCRYPTION_KEY_HEADER_KEY}`, value);
  },
  getPlaintextEncryptionKey() {
    return contextValue(EXPS_CONST.PLAINTEXT_ENCRYPTION_KEY);
  },
  setPlaintextEncryptionKey(value) {
    return contextValue(EXPS_CONST.PLAINTEXT_ENCRYPTION_KEY, value);
  }
};

class LruTtlStore {
  constructor(options = {}) {
    this.max = options.max || 1000;
    this.ttlMs = options.ttlMs || 60000;
    this.map = new Map();
  }

  get(key) {
    const item = this.map.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, item);
    return item.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, item] of this.map) {
      if (item.expiresAt <= now) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

function asyncHandler(fn) {
  return function veloraAsyncHandler(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function requestContext(options = {}) {
  const header = (options.header || 'x-request-id').toLowerCase();
  const generator = options.generator || randomUUID;
  return function veloraRequestContext(req, res, next) {
    const requestId = String(req.headers?.[header] || generator());
    const startedAt = performance.now();
    const store = {
      requestId,
      startedAt,
      data: new Map(),
      deadlineAt: options.timeoutMs ? Date.now() + options.timeoutMs : undefined
    };
    res.setHeader?.(header, requestId);
    context.run(store, () => next());
  };
}

function getRequestContext() {
  return context.getStore();
}

function contextValue(key, value) {
  const store = context.getStore();
  if (!store) return undefined;
  if (arguments.length === 1) return store.data.get(key);
  store.data.set(key, value);
  return value;
}

function validate(schema, value, options = {}) {
  try {
    if (schema?.safeParse) {
      const result = schema.safeParse(value);
      if (result.success) return result.data;
      throw new ApiError(options.status || 422, options.message || 'Validation failed', {
        code: options.code || 'VALIDATION_FAILED',
        detail: normalizeValidationError(result.error)
      });
    }
    if (schema?.parse) return schema.parse(value);
    if (typeof schema === 'function') {
      const result = schema(value);
      if (result === true || result === undefined) return value;
      if (result?.value !== undefined) return result.value;
      if (result?.error) throw result.error;
      return result;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(options.status || 422, options.message || 'Validation failed', {
      code: options.code || 'VALIDATION_FAILED',
      detail: normalizeValidationError(error),
      cause: error
    });
  }
  throw new ApiError(500, 'Invalid validator schema', { code: 'INVALID_VALIDATOR' });
}

function validateRequest(schemas = {}, options = {}) {
  return function veloraValidateRequest(req, _res, next) {
    try {
      if (schemas.params) req.params = validate(schemas.params, req.params, options);
      if (schemas.query) req.query = validate(schemas.query, req.query, options);
      if (schemas.body) req.body = validate(schemas.body, req.body, options);
      if (schemas.headers) req.validatedHeaders = validate(schemas.headers, req.headers, options);
      next();
    } catch (error) {
      next(error);
    }
  };
}

function problemDetails(options = {}) {
  return function veloraProblemDetails(error, req, res, _next) {
    const err = error instanceof ApiError ? error : new ApiError(error.status || 500, error.message, {
      cause: error,
      expose: options.exposeInternalErrors || error.expose
    });
    for (const [key, value] of Object.entries(err.headers || {})) res.setHeader?.(key, value);
    res.status?.(err.status);
    res.type?.('application/problem+json');
    res.json?.(err.toProblem(req.originalUrl || req.url));
  };
}

function makeProblem(status, title = STATUS_TEXT[status] || 'Error', extras = {}) {
  const problem = {
    type: extras.type || `https://httpstatuses.com/${status}`,
    title,
    status
  };
  if (extras.detail !== undefined) problem.detail = extras.detail;
  if (extras.instance) problem.instance = extras.instance;
  if (extras.code) problem.code = extras.code;
  return problem;
}

function securityHeaders(options = {}) {
  const defaults = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()'
  };
  const headers = { ...defaults, ...(options.headers || {}) };
  if (options.contentSecurityPolicy) headers['content-security-policy'] = options.contentSecurityPolicy;
  return function veloraSecurityHeaders(_req, res, next) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== false) res.setHeader?.(key, value);
    }
    next();
  };
}

function rateLimit(options = {}) {
  const store = options.store || createMemoryRateLimitStore(options);
  const key = options.key || ((req) => req.ip || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'global');
  return function veloraRateLimit(req, res, next) {
    const result = store.hit(String(key(req)));
    res.setHeader?.('ratelimit-limit', result.limit);
    res.setHeader?.('ratelimit-remaining', result.remaining);
    res.setHeader?.('ratelimit-reset', Math.ceil(result.resetAt / 1000));
    if (!result.allowed) {
      next(new ApiError(429, options.message || 'Rate limit exceeded', {
        code: 'RATE_LIMITED',
        headers: { 'retry-after': Math.ceil(result.retryAfterMs / 1000) }
      }));
      return;
    }
    next();
  };
}

function createMemoryRateLimitStore(options = {}) {
  const windowMs = options.windowMs || 60000;
  const limit = options.limit || 100;
  const buckets = new Map();
  return {
    hit(key) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      const remaining = Math.max(0, limit - bucket.count);
      return {
        allowed: bucket.count <= limit,
        limit,
        remaining,
        resetAt: bucket.resetAt,
        retryAfterMs: Math.max(0, bucket.resetAt - now)
      };
    },
    reset(key) {
      buckets.delete(key);
    },
    sweep(now = Date.now()) {
      let removed = 0;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
          removed += 1;
        }
      }
      return removed;
    }
  };
}

function idempotency(options = {}) {
  const store = options.store || new LruTtlStore({ max: options.max || 5000, ttlMs: options.ttlMs || 86400000 });
  const methods = new Set(options.methods || ['POST', 'PATCH', 'PUT']);
  const header = (options.header || 'idempotency-key').toLowerCase();
  return asyncHandler(async function veloraIdempotency(req, res, next) {
    if (!methods.has(req.method)) return next();
    const key = req.headers?.[header];
    if (!key) return next(new ApiError(400, 'Missing idempotency key', { code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    const cached = store.get(`${req.method}:${req.originalUrl || req.url}:${key}`);
    if (cached) {
      res.status?.(cached.status);
      for (const [name, value] of Object.entries(cached.headers)) res.setHeader?.(name, value);
      res.setHeader?.('idempotency-replayed', 'true');
      res.send?.(cached.body);
      return;
    }
    const originalSend = res.send?.bind(res);
    if (!originalSend) return next();
    res.send = (body) => {
      if ((res.statusCode || 200) < 500) {
        store.set(`${req.method}:${req.originalUrl || req.url}:${key}`, {
          status: res.statusCode || 200,
          headers: pickCacheableHeaders(res),
          body
        });
      }
      return originalSend(body);
    };
    next();
  });
}

function httpCache(options = {}) {
  const store = options.store || new LruTtlStore({ max: options.max || 1000, ttlMs: options.ttlMs || 30000 });
  const key = options.key || ((req) => `${req.method}:${req.originalUrl || req.url}`);
  return function veloraHttpCache(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const cacheKey = key(req);
    const cached = store.get(cacheKey);
    if (cached) {
      res.setHeader?.('x-cache', 'HIT');
      res.status?.(cached.status);
      for (const [name, value] of Object.entries(cached.headers)) res.setHeader?.(name, value);
      res.send?.(cached.body);
      return;
    }
    const originalSend = res.send?.bind(res);
    if (!originalSend) return next();
    res.send = (body) => {
      if ((res.statusCode || 200) >= 200 && (res.statusCode || 200) < 300) {
        const ttlMs = typeof options.ttlMs === 'function' ? options.ttlMs(req, res, body) : options.ttlMs;
        store.set(cacheKey, { status: res.statusCode || 200, headers: pickCacheableHeaders(res), body }, ttlMs);
      }
      res.setHeader?.('x-cache', 'MISS');
      return originalSend(body);
    };
    next();
  };
}

function etag(options = {}) {
  const weak = options.weak ?? true;
  return function veloraEtag(req, res, next) {
    const originalSend = res.send?.bind(res);
    if (!originalSend) return next();
    res.send = (body) => {
      const tag = makeEtag(body, weak);
      res.setHeader?.('etag', tag);
      if (req.headers?.['if-none-match'] === tag) {
        res.status?.(304);
        return originalSend('');
      }
      return originalSend(body);
    };
    next();
  };
}

function deadline(options = {}) {
  return function veloraDeadline(req, res, next) {
    const timeoutMs = Number(req.headers?.['x-deadline-ms'] || options.timeoutMs || 30000);
    const timer = setTimeout(() => {
      if (!res.headersSent) next(new ApiError(504, 'Request deadline exceeded', { code: 'DEADLINE_EXCEEDED' }));
    }, timeoutMs);
    res.on?.('finish', () => clearTimeout(timer));
    res.on?.('close', () => clearTimeout(timer));
    next();
  };
}

function withTimeout(work, timeoutMs, message = 'Operation timed out') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiError(504, message, { code: 'OPERATION_TIMEOUT' })), timeoutMs);
    Promise.resolve()
      .then(work)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold || 5;
  const resetAfterMs = options.resetAfterMs || 30000;
  let failures = 0;
  let openedAt = 0;
  return {
    get state() {
      if (!openedAt) return 'closed';
      return Date.now() - openedAt >= resetAfterMs ? 'half-open' : 'open';
    },
    async exec(work) {
      if (this.state === 'open') throw new ApiError(503, 'Circuit is open', { code: 'CIRCUIT_OPEN' });
      try {
        const result = await work();
        failures = 0;
        openedAt = 0;
        return result;
      } catch (error) {
        failures += 1;
        if (failures >= failureThreshold) openedAt = Date.now();
        throw error;
      }
    },
    reset() {
      failures = 0;
      openedAt = 0;
    }
  };
}

function createRoute(router) {
  return {
    get: routeFactory(router, 'get'),
    post: routeFactory(router, 'post'),
    put: routeFactory(router, 'put'),
    patch: routeFactory(router, 'patch'),
    delete: routeFactory(router, 'delete')
  };
}

function smartJson(options = {}) {
  return function veloraSmartJson(req, res, next) {
    res.ok = (data, meta) => res.status(200).json({ ok: true, data, meta });
    res.created = (data, meta) => res.status(201).json({ ok: true, data, meta });
    res.accepted = (data, meta) => res.status(202).json({ ok: true, data, meta });
    res.noContent = () => res.status(204).send('');
    res.problem = (status, title, extras) => res.status(status).type('application/problem+json').json(makeProblem(status, title, extras));
    if (options.poweredBy !== false) res.setHeader?.('x-powered-by', 'velora-express');
    next();
  };
}

function metrics(options = {}) {
  const sink = options.sink || (() => {});
  return function veloraMetrics(req, res, next) {
    const start = performance.now();
    res.on?.('finish', () => {
      sink({
        method: req.method,
        route: req.route?.path || req.originalUrl || req.url,
        status: res.statusCode,
        durationMs: performance.now() - start,
        requestId: getRequestContext()?.requestId
      });
    });
    next();
  };
}

function safeJson(value, space) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  }, space);
}

function stableHash(value, algorithm = 'sha256') {
  return createHash(algorithm).update(typeof value === 'string' ? value : safeJson(sortKeys(value))).digest('hex');
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '';
}

function extractHeaders(req, res, next) {
  const headers = req.headers || {};
  for (const [header, value] of Object.entries(headers)) {
    httpContext.set(`headers.${header.toLowerCase()}`, value);
  }
  if (!httpContext.getRequestId()) httpContext.setRequestId(randomUUID());
  if (!httpContext.getSessionId()) httpContext.setSessionId(randomUUID());
  res.locals ||= {};
  res.locals.velora = { requestId: httpContext.getRequestId(), sessionId: httpContext.getSessionId() };
  queueMicrotask(next);
}

function routeSanity(req, _res, next) {
  req.isMatch = true;
  queueMicrotask(next);
}

function logManager(disableBodyLog = false) {
  return function veloraLogManager(req, _res, next) {
    req.disableBodyLog = Boolean(disableBodyLog);
    queueMicrotask(next);
  };
}

function apiLogging(options = {}) {
  if (typeof options === 'function') {
    return apiLogging({ sink: options });
  }
  const sink = options.sink || ((entry) => {
    const level = entry.res.statusCode >= 500 ? 'error' : entry.res.statusCode >= 400 ? 'warn' : 'info';
    (veloraState.logger[level] || veloraState.logger.info || console.log).call(veloraState.logger, entry);
  });
  const redact = createRedactor(options.redact || ['authorization', 'cookie', 'password', 'token', 'secret', 'payload']);
  return function veloraApiLogging(req, res, next) {
    req.timestamp = Date.now();
    res.on?.('finish', () => sink(buildLogMeta(req, res, redact)));
    req.on?.('aborted', () => {
      req.isAborted = true;
      sink(buildLogMeta(req, undefined, redact));
    });
    queueMicrotask(next);
  };
}

function handleResponse(req, res, next) {
  setResponseHeaders(res);
  const body = res.encryptedBody || res.body;
  if (res.isError || req.isMatch) {
    sendResponseBody(res, body);
  } else {
    const message = `Cannot ${req.method} ${req.originalUrl || req.url}`;
    sendResponseBody(res, new ResponseBody(404, message));
  }
  res.emit?.(EXPS_CONST.RESPONSE_COMPLETED_EVENT);
}

function handleError(error, req, res, next) {
  if (!error) return queueMicrotask(next);
  if (error instanceof ResponseBody) {
    res.body = error;
  } else {
    const customError = error instanceof CustomError ? error : new CustomError(error);
    res.body = new ResponseBody(
      customError.statusCode,
      customError.message,
      customError.data,
      customError.error,
      customError.errorCode
    );
  }
  res.isError = true;
  const key = httpContext.getPlaintextEncryptionKey();
  if (key && veloraState.crypto?.encryptData) {
    const payload = veloraState.crypto.encryptData(safeJson(res.body), key);
    res.encryptedBody = new ResponseBody(200, 'Success', { payload });
  }
  return handleResponse(req, res, next);
}

async function decryptCryptoKey(_req, _res, next) {
  try {
    const clientId = httpContext.getClientId();
    const encryptedKey = httpContext.getEncryptionKey();
    if (encryptedKey && veloraState.validateClient) await veloraState.validateClient(clientId);
    const key = encryptedKey && veloraState.crypto?.decryptKey
      ? await veloraState.crypto.decryptKey(clientId, encryptedKey)
      : encryptedKey;
    if (key) httpContext.setPlaintextEncryptionKey(key);
    next();
  } catch (error) {
    next(error);
  }
}

function decryptPayload(req, _res, next) {
  try {
    const key = httpContext.getPlaintextEncryptionKey();
    const payload = req.body?.payload;
    if (key && payload && veloraState.crypto?.decryptData) {
      req.body = veloraState.crypto.decryptData(payload, key);
    } else if (key && !payload) {
      req.body = {};
    }
    queueMicrotask(next);
  } catch (error) {
    next(error);
  }
}

function encryptPayload(_req, res, next) {
  try {
    const key = httpContext.getPlaintextEncryptionKey();
    if (key && res.body && veloraState.crypto?.encryptData) {
      const payload = veloraState.crypto.encryptData(safeJson(res.body), key);
      res.encryptedBody = new ResponseBody(200, 'Success', { payload });
    }
    queueMicrotask(next);
  } catch (error) {
    next(error);
  }
}

function configureApp(app, routes = [], options = {}) {
  if (!app?.use) throw new CustomError(new Error('app / app.use is undefined'), {
    statusCode: 500,
    errorCode: 'Velora::APP_CONFIG_FAILED'
  });
  app.use(requestContext({ header: EXPS_CONST.REQUEST_ID_HEADER_KEY }));
  app.use(extractHeaders);
  if (options.security !== false) app.use(securityHeaders(options.security));
  if (options.deadline) app.use(deadline(options.deadline));
  if (options.logging !== false) app.use(apiLogging(options.logging || {}));
  for (const route of defaultRoutes(options)) {
    app[route.method](route.path, ...(route.pipeline || []));
  }
  for (const route of routes) app.use(route.path, route.router);
  app.use(handleResponse);
  app.use(handleError);
}

function configureRouter(router, masterConfig = {}, customConfig = {}) {
  const config = deepMerge(masterConfig, customConfig);
  const {
    routesConfig = {},
    enabled: routerEnabled = false,
    disableCrypto: routerDisableCrypto = false,
    disableBodyLog: routerDisableBodyLog = false,
    preMiddlewares = [],
    postMiddlewares = []
  } = config;
  const disabledRoutes = [];
  for (const [name, routeConfig] of Object.entries(routesConfig)) {
    const {
      method,
      path,
      prePipeline = [],
      pipeline = [],
      postPipeline = [],
      enabled = false,
      disableCrypto = false,
      disableBodyLog = false,
      cache,
      rateLimit: routeRateLimit,
      validate: validators
    } = routeConfig || {};
    if (!method || !path || typeof router[method.toLowerCase()] !== 'function') {
      veloraState.logger.error?.(`[${SERVICE} VeloraExpress] Unable to configure route: ${name}`);
      continue;
    }
    if (!enabled && !routerEnabled) {
      disabledRoutes.push(name);
      continue;
    }
    const cryptoPre = disableCrypto || routerDisableCrypto ? [] : [decryptCryptoKey, decryptPayload];
    const cryptoPost = disableCrypto || routerDisableCrypto ? [] : [encryptPayload];
    const routeMiddlewares = [
      routeSanity,
      logManager(disableBodyLog || routerDisableBodyLog),
      cache && responseCache(cache),
      routeRateLimit && rateLimit(routeRateLimit),
      validators && validateRequest(validators),
      ...preMiddlewares,
      ...prePipeline,
      ...cryptoPre,
      ...pipeline,
      ...cryptoPost,
      ...postPipeline,
      ...postMiddlewares,
      handleResponse
    ].filter(Boolean).map((mw) => mw === handleResponse ? mw : asyncWrapper(mw));
    router[method.toLowerCase()](path, ...routeMiddlewares);
  }
  if (disabledRoutes.length) {
    veloraState.logger.warn?.(`[${SERVICE} VeloraExpress] Disabled routes: ${disabledRoutes.join(', ')}`);
  }
  return router;
}

function responseCache(options = {}) {
  const store = options.store || new LruTtlStore({ max: options.max || 1000, ttlMs: options.ttlMs || 30000 });
  const key = options.key || ((req) => `${req.method}:${req.originalUrl || req.url}:${stableHash(req.query || {})}`);
  const methods = new Set(options.methods || ['GET', 'HEAD']);
  return function veloraResponseCache(req, res, next) {
    if (!methods.has(req.method)) return next();
    const cacheKey = key(req);
    const cached = store.get(cacheKey);
    if (cached) {
      res.setHeader?.('x-cache', cached.stale ? 'STALE' : 'HIT');
      res.body = cached.body;
      req.isMatch = true;
      return handleResponse(req, res, next);
    }
    const originalJson = res.json?.bind(res);
    const originalSend = res.send?.bind(res);
    res.json = (body) => {
      if (isCacheableStatus(res.statusCode || body?.statusCode || 200)) store.set(cacheKey, { body });
      return originalJson(body);
    };
    res.send = (body) => {
      if (isCacheableStatus(res.statusCode || 200)) store.set(cacheKey, { body });
      return originalSend(body);
    };
    res.on?.(EXPS_CONST.RESPONSE_COMPLETED_EVENT, () => {
      if (res.body && isCacheableStatus(res.body.statusCode)) store.set(cacheKey, { body: res.body });
    });
    next();
  };
}

const DEFAULT_ROUTES = [
  { method: 'get', path: '/health', pipeline: [(_req, res, next) => { res.body = new ResponseBody(200, 'Success', { status: 'up' }); next(); }, handleResponse] }
];

function setResponseHeaders(res) {
  const requestId = httpContext.getRequestId();
  const sessionId = httpContext.getSessionId();
  if (requestId) res.setHeader?.(EXPS_CONST.REQUEST_ID_HEADER_KEY, requestId);
  if (sessionId) res.setHeader?.(EXPS_CONST.SESSION_ID_HEADER_KEY, sessionId);
  const exposed = String(res.getHeader?.('Access-Control-Expose-Headers') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const header of [EXPS_CONST.REQUEST_ID_HEADER_KEY, EXPS_CONST.SESSION_ID_HEADER_KEY]) {
    if (!exposed.includes(header)) exposed.push(header);
  }
  res.setHeader?.('Access-Control-Expose-Headers', exposed.join(','));
}

function sendResponseBody(res, candidate) {
  let body = candidate || {};
  if (!body.statusCode) body = new ResponseBody(500, 'Response Data Not Found!');
  res.body = body;
  if ([301, 302, 307, 308].includes(body.statusCode) && body.data && res.redirect) {
    res.status(body.statusCode).redirect(body.data);
    return;
  }
  res.status?.(body.statusCode);
  res.json?.(body);
}

function buildLogMeta(req, res, redact) {
  const isAborted = req.isAborted === true;
  const statusCode = isAborted ? 499 : res?.statusCode || 500;
  const status = isAborted ? 'Request Aborted' : res?.statusMessage || STATUS_TEXT[statusCode] || 'Internal Server Error';
  const responseTime = req.timestamp ? Date.now() - req.timestamp : -1;
  const requestUrl = req.originalUrl || req.url;
  const httpVersion = `${req.httpVersionMajor || 1}.${req.httpVersionMinor || 1}`;
  return {
    type: res ? 'REQ_RES_LOG' : 'REQ_LOG',
    message: `[HTTP/${httpVersion}] ${req.method} ${requestUrl} | ${statusCode} ${status} | ${responseTime}ms`,
    req: {
      httpVersion,
      ipAddress: clientIp(req),
      url: requestUrl,
      method: req.method,
      headers: redact({ ...(req.headers || {}) }),
      body: req.disableBodyLog ? {} : redact(req.body || {})
    },
    res: {
      statusCode,
      status,
      headers: redact(res?.getHeaders?.() || {}),
      body: req.disableBodyLog ? {} : redact(res?.body || {}),
      responseMessage: res?.body?.message || '',
      responseTime
    },
    requestId: httpContext.getRequestId(),
    sessionId: httpContext.getSessionId()
  };
}

function createRedactor(keys) {
  const patterns = keys.map((key) => String(key).toLowerCase());
  const redactValue = '[Redacted]';
  return function redact(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(redact);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const shouldRedact = patterns.some((pattern) => key.toLowerCase().includes(pattern));
      return [key, shouldRedact ? redactValue : redact(item)];
    }));
  };
}

function defaultRoutes(options) {
  if (options.defaultRoutes === false) return [];
  return options.defaultRoutes || DEFAULT_ROUTES;
}

function isCacheableStatus(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

function deepMerge(left = {}, right = {}) {
  const output = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map)
      ? deepMerge(output[key], value)
      : value;
  }
  return output;
}

function createPayloadCrypto(secret = process.env.VELORA_CRYPTO_SECRET || 'velora-development-secret') {
  const keyFrom = (value) => createHash('sha256').update(String(value || secret)).digest();
  return {
    async decryptKey(_clientId, encryptedKey) {
      return encryptedKey;
    },
    encryptData(value, key = secret) {
      const iv = randomUUID().replaceAll('-', '').slice(0, 24);
      const cipher = createCipheriv('aes-256-gcm', keyFrom(key), Buffer.from(iv, 'hex'));
      const encrypted = Buffer.concat([cipher.update(typeof value === 'string' ? value : safeJson(value), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${iv}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
    },
    decryptData(payload, key = secret) {
      const [iv, tag, encrypted] = String(payload).split('.');
      const decipher = createDecipheriv('aes-256-gcm', keyFrom(key), Buffer.from(iv, 'hex'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const text = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  };
}

function routeFactory(router, method) {
  return (path, options, handler) => {
    const middleware = [];
    if (options?.validate) middleware.push(validateRequest(options.validate, options.validation));
    if (options?.rateLimit) middleware.push(rateLimit(options.rateLimit));
    if (options?.cache) middleware.push(httpCache(options.cache));
    middleware.push(asyncHandler(handler || options));
    router[method](path, ...middleware);
    return router;
  };
}

function normalizeValidationError(error) {
  if (!error) return undefined;
  if (Array.isArray(error.issues)) return error.issues;
  if (Array.isArray(error.errors)) return error.errors;
  if (error.message) return error.message;
  return error;
}

function pickCacheableHeaders(res) {
  const getHeaders = res.getHeaders?.() || {};
  const allowed = ['content-type', 'cache-control', 'etag', 'last-modified', 'vary'];
  return Object.fromEntries(Object.entries(getHeaders).filter(([key]) => allowed.includes(key.toLowerCase())));
}

function makeEtag(body, weak) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : safeJson(body));
  const value = createHash('sha1').update(payload).digest('base64url');
  return weak ? `W/"${payload.length}-${value}"` : `"${payload.length}-${value}"`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortKeys(value[key]);
    return acc;
  }, {});
}


module.exports = { initialize, asyncHandler, requestContext, getRequestContext, contextValue, validate, validateRequest, problemDetails, makeProblem, securityHeaders, rateLimit, createMemoryRateLimitStore, idempotency, httpCache, etag, deadline, withTimeout, createCircuitBreaker, createRoute, smartJson, metrics, safeJson, stableHash, constantTimeEqual, clientIp, extractHeaders, routeSanity, logManager, apiLogging, handleResponse, handleError, decryptCryptoKey, decryptPayload, encryptPayload, configureApp, configureRouter, responseCache, createPayloadCrypto, EXPS_CONST, ExpressUtils, asyncWrapper, httpContext, DEFAULT_ROUTES, ResponseBody, CustomError, ApiError, LruTtlStore };
