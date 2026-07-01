import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export interface ApiErrorOptions {
  code?: string;
  expose?: boolean;
  detail?: unknown;
  data?: unknown;
  headers?: Record<string, string | number>;
  cause?: unknown;
}

export class ApiError extends Error {
  status: number;
  statusCode: number;
  code: string;
  errorCode: string;
  expose: boolean;
  detail?: unknown;
  data?: unknown;
  headers: Record<string, string | number>;
  constructor(status?: number, message?: string, options?: ApiErrorOptions);
  toProblem(instance?: string): ProblemDetails;
}

export class ResponseBody {
  statusCode: number;
  status: string;
  message: string;
  data: unknown;
  error: unknown;
  errorCode: string | null;
  constructor(statusCode?: number, message?: string, data?: unknown, error?: unknown, errorCode?: string);
}

export interface CustomErrorMap {
  statusCode?: number;
  message?: string;
  errorCode?: string;
  data?: unknown;
}

export class CustomError extends Error {
  readonly _isCustomError: true;
  readonly service: string;
  statusCode: number;
  errorCode: string;
  error?: unknown;
  data?: unknown;
  constructor(error?: unknown, errorMap?: CustomErrorMap);
}

export const EXPS_CONST: {
  REQUEST_ID_HEADER_KEY: 'x-req-id';
  SESSION_ID_HEADER_KEY: 'x-session-id';
  CLIENT_ID_HEADER_KEY: 'x-api-client-id';
  ENCRYPTION_KEY_HEADER_KEY: 'x-api-encryption-key';
  PLAINTEXT_ENCRYPTION_KEY: 'plaintext-api-encryption-key';
  RESPONSE_COMPLETED_EVENT: 'velora-express-completed';
};

export const ExpressUtils: { initialize: typeof initialize };
export function initialize(options?: InitializeOptions | ClientValidator): Promise<void>;
export const asyncWrapper: typeof asyncHandler;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: unknown;
  instance?: string;
  code?: string;
}

export interface LruTtlStoreOptions {
  max?: number;
  ttlMs?: number;
}

export class LruTtlStore<T = unknown> {
  constructor(options?: LruTtlStoreOptions);
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs?: number): T;
  delete(key: string): boolean;
  clear(): void;
  sweep(now?: number): number;
}

export interface RequestContextStore {
  requestId: string;
  startedAt: number;
  deadlineAt?: number;
  data: Map<string, unknown>;
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>): RequestHandler;
export function requestContext(options?: { header?: string; generator?: () => string; timeoutMs?: number }): RequestHandler;
export function getRequestContext(): RequestContextStore | undefined;
export function contextValue<T = unknown>(key: string): T | undefined;
export function contextValue<T = unknown>(key: string, value: T): T;

export interface HttpContext {
  get<T = unknown>(key?: string): T | RequestContextStore | undefined;
  set<T = unknown>(key: string, value: T): T | undefined;
  getRequestId(): string | undefined;
  setRequestId(value: string): string | undefined;
  getSessionId(): string | undefined;
  setSessionId(value: string): string | undefined;
  getClientId(): string | undefined;
  setClientId(value: string): string | undefined;
  getEncryptionKey(): string | undefined;
  setEncryptionKey(value: string): string | undefined;
  getPlaintextEncryptionKey(): string | undefined;
  setPlaintextEncryptionKey(value: string): string | undefined;
}

export const httpContext: HttpContext;

export type Validator<T = unknown> =
  | { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } }
  | { parse(value: unknown): T }
  | ((value: unknown) => T | true | undefined | { value?: T; error?: unknown });

export function validate<T>(schema: Validator<T>, value: unknown, options?: { status?: number; message?: string; code?: string }): T;
export function validateRequest(schemas?: {
  params?: Validator;
  query?: Validator;
  body?: Validator;
  headers?: Validator;
}, options?: { status?: number; message?: string; code?: string }): RequestHandler;

export function problemDetails(options?: { exposeInternalErrors?: boolean }): (error: unknown, req: Request, res: Response, next: NextFunction) => void;
export function makeProblem(status: number, title?: string, extras?: Partial<ProblemDetails>): ProblemDetails;
export function securityHeaders(options?: { contentSecurityPolicy?: string; headers?: Record<string, string | false> }): RequestHandler;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

export interface RateLimitStore {
  hit(key: string): RateLimitResult;
  reset?(key: string): void;
  sweep?(now?: number): number;
}

export function createMemoryRateLimitStore(options?: { windowMs?: number; limit?: number }): RateLimitStore;
export function rateLimit(options?: { windowMs?: number; limit?: number; store?: RateLimitStore; key?: (req: Request) => string; message?: string }): RequestHandler;
export function idempotency(options?: { store?: LruTtlStore; max?: number; ttlMs?: number; methods?: string[]; header?: string }): RequestHandler;
export function httpCache(options?: { store?: LruTtlStore; max?: number; ttlMs?: number | ((req: Request, res: Response, body: unknown) => number); key?: (req: Request) => string }): RequestHandler;
export function etag(options?: { weak?: boolean }): RequestHandler;
export function deadline(options?: { timeoutMs?: number }): RequestHandler;
export function withTimeout<T>(work: () => T | Promise<T>, timeoutMs: number, message?: string): Promise<T>;

export interface CircuitBreaker {
  readonly state: 'closed' | 'open' | 'half-open';
  exec<T>(work: () => T | Promise<T>): Promise<T>;
  reset(): void;
}

export function createCircuitBreaker(options?: { failureThreshold?: number; resetAfterMs?: number }): CircuitBreaker;
export function createRoute(router: Router): Record<'get' | 'post' | 'put' | 'patch' | 'delete', (path: string, options: unknown, handler?: RequestHandler) => Router>;
export function smartJson(options?: { poweredBy?: boolean }): RequestHandler;
export function metrics(options?: { sink?: (metric: { method: string; route: string; status: number; durationMs: number; requestId?: string }) => void }): RequestHandler;
export function safeJson(value: unknown, space?: number): string;
export function stableHash(value: unknown, algorithm?: string): string;
export function constantTimeEqual(a: unknown, b: unknown): boolean;
export function clientIp(req: Request): string;

export type ExpsMiddleware = (req: Request & Record<string, any>, res: Response & Record<string, any>, next: NextFunction) => unknown | Promise<unknown>;
export type ClientValidator = (clientId?: string) => unknown | Promise<unknown>;

export interface PayloadCrypto {
  decryptKey?(clientId?: string, encryptedKey?: string): string | Promise<string>;
  encryptData(value: unknown, key?: string): string;
  decryptData(payload: string, key?: string): unknown;
}

export interface InitializeOptions {
  validateClient?: ClientValidator;
  crypto?: PayloadCrypto;
  cryptoSecret?: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error' | 'log'>;
}

export interface ExpsRouteConfig {
  method: string;
  path: string;
  enabled?: boolean;
  disableCrypto?: boolean;
  disableBodyLog?: boolean;
  prePipeline?: ExpsMiddleware[];
  pipeline?: ExpsMiddleware[];
  postPipeline?: ExpsMiddleware[];
  cache?: Parameters<typeof responseCache>[0];
  rateLimit?: Parameters<typeof rateLimit>[0];
  validate?: Parameters<typeof validateRequest>[0];
}

export interface ExpsRouterConfig {
  routerName?: string;
  enabled?: boolean;
  disableCrypto?: boolean;
  disableBodyLog?: boolean;
  preMiddlewares?: ExpsMiddleware[];
  postMiddlewares?: ExpsMiddleware[];
  routesConfig?: Record<string, ExpsRouteConfig>;
}

export function extractHeaders(req: Request, res: Response, next: NextFunction): void;
export function routeSanity(req: Request, res: Response, next: NextFunction): void;
export function logManager(disableBodyLog?: boolean): RequestHandler;
export function apiLogging(options?: { sink?: (entry: unknown) => void; redact?: string[] } | ((entry: unknown) => void)): RequestHandler;
export function handleResponse(req: Request, res: Response, next: NextFunction): void;
export function handleError(error: unknown, req: Request, res: Response, next: NextFunction): void;
export function decryptCryptoKey(req: Request, res: Response, next: NextFunction): Promise<void>;
export function decryptPayload(req: Request, res: Response, next: NextFunction): void;
export function encryptPayload(req: Request, res: Response, next: NextFunction): void;
export function configureApp(app: { use: Function; [key: string]: any }, routes?: Array<{ path: string; router: Router }>, options?: {
  security?: false | Parameters<typeof securityHeaders>[0];
  deadline?: Parameters<typeof deadline>[0];
  logging?: false | Parameters<typeof apiLogging>[0];
  defaultRoutes?: false | Array<{ method: string; path: string; pipeline?: ExpsMiddleware[] }>;
}): void;
export function configureRouter(router: Router & Record<string, Function>, masterConfig?: ExpsRouterConfig, customConfig?: ExpsRouterConfig): Router;
export function responseCache(options?: { store?: LruTtlStore; max?: number; ttlMs?: number; methods?: string[]; key?: (req: Request) => string }): RequestHandler;
export function createPayloadCrypto(secret?: string): PayloadCrypto;
export const DEFAULT_ROUTES: Array<{ method: string; path: string; pipeline?: ExpsMiddleware[] }>;
