import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { ErrorCode } from '../contracts/index.ts';

type Code = z.infer<typeof ErrorCode>;
export const STATUS: Record<Code, number> = {
  unauthenticated: 401, forbidden: 403, not_found: 404, invalid_request: 400, conflict: 409, rate_limited: 429, internal: 500,
};

/** An error whose code and message are safe to return to the caller. */
export class ApiError extends Error {
  constructor(readonly code: Code, message: string) { super(message); }
}
export const fail = (code: Code, message: string): never => { throw new ApiError(code, message); };
export const notFound = (): never => fail('not_found', 'Not found');

/** JSON with object keys sorted at every level, so equal data always hashes the same. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
