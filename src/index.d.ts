import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export interface ApiErrorOptions {
  code?: string;
  expose?: boolean;
  detail?: unknown;
  headers?: Record<string, string | number>;
  cause?: unknown;
}

export class ApiError extends Error {
  status: number;
  code: string;
  expose: boolean;
  detail?: unknown;
  headers: Record<string, string | number>;
  constructor(status?: number, message?: string, options?: ApiErrorOptions);
  toProblem(instance?: string): ProblemDetails;
}

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
