// One router for every path in ROUTES. Handlers are thin: authenticate, check role, validate with Zod, call a service.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ZodError, type z } from 'zod';
import {
  CreateInvoiceRequest, CreatePurchaseOrderRequest, DraftMessageRequest, IdempotencyKey, ResolveRequest, ROUTES, type Role,
} from '../contracts/index';
import { asUser, type Db } from '../db/index';
import { authenticate, type Caller, type TokenVerifier } from '../services/auth';
import { findDuplicateCandidates } from '../services/duplicates';
import { createInvoice, createPurchaseOrder } from '../services/invoices';
import { enqueue, runJobs } from '../services/jobs';
import { draftSupplierMessage } from '../services/matching';
import { discrepancyHistory, getDiscrepancies, getInvoiceDto, listInvoices, listPurchaseOrders } from '../services/records';
import { getInvestigation, requestInvestigation, resolveDiscrepancy } from '../services/resolution';
import type { Storage } from '../services/storage';
import { ApiError, canonical, fail, notFound, sha256, STATUS } from '../services/util';
import { processInvoice } from '../services/validation';

export type Deps = {
  db: Db; verifyToken: TokenVerifier; storage: Storage;
  now?: () => Date; cronSecret?: string; model?: string; rateLimitPerMinute?: number; signedUrlSeconds?: number;
  log?: (entry: Record<string, unknown>) => void;
  /** Public Supabase client settings for GET /api/config. Unset: that route answers 500. */
  publicConfig?: { supabase_url: string; supabase_anon_key: string };
  /** Runs work after the response is sent (Vercel waitUntil). Used to start the worker as soon as an investigation is queued. */
  defer?: (fn: () => Promise<unknown>) => void;
};
export type HttpRequest = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
export type HttpResponse = { status: number; body: unknown };

type RouteKey = keyof typeof ROUTES;
type JobRequest = { kind: string; payload: Record<string, unknown>; idempotencyKey: string };
type Ctx = { tx: Db; caller: Caller; id: string; body: unknown; deps: Deps };
type Result = { status?: number; data: unknown; jobs?: JobRequest[] };

const RANK: Record<z.infer<typeof Role>, number> = { viewer: 0, reviewer: 1, admin: 2 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const user = (c: Ctx) => ({ orgId: c.caller.orgId, userId: c.caller.userId });

const HANDLERS: Record<Exclude<RouteKey, 'POST /api/jobs/run' | 'GET /api/jobs/run' | 'GET /api/config'>, (c: Ctx) => Promise<Result>> = {
  'POST /api/invoices': async (c) => {
    const id = await createInvoice(c.tx, user(c), CreateInvoiceRequest.parse(c.body), c.deps.storage);
    return { status: 201, data: await getInvoiceDto(c.tx, c.caller.orgId, id) };
  },
  'GET /api/invoices': async (c) => ({ data: await listInvoices(c.tx, c.caller.orgId) }),
  'GET /api/invoices/:id': async (c) => ({
    data: await getInvoiceDto(c.tx, c.caller.orgId, c.id, (path) => c.deps.storage.signedUrl(path, c.deps.signedUrlSeconds ?? 300)),
  }),
  'POST /api/invoices/:id/process': async (c) => {
    await processInvoice(c.tx, c.caller.orgId, c.id, { type: 'user', id: c.caller.userId });
    return { data: await getInvoiceDto(c.tx, c.caller.orgId, c.id) };
  },
  'GET /api/invoices/:id/discrepancies': async (c) => ({ data: (await getDiscrepancies(c.tx, c.caller.orgId, c.id)).data }),
  'GET /api/invoices/:id/duplicate-candidates': async (c) => {
    const r = await findDuplicateCandidates(c.tx, c.caller.orgId, c.id);
    return { data: { ...r.data, evidence: r.evidence } };
  },
  'POST /api/purchase-orders': async (c) => {
    const r = await createPurchaseOrder(c.tx, user(c), CreatePurchaseOrderRequest.parse(c.body));
    const pos = await listPurchaseOrders(c.tx, c.caller.orgId);
    return {
      status: 201, data: pos.find((p) => p.id === r.purchaseOrderId),
      jobs: r.waitingInvoiceIds.map((id) => ({ kind: 'process_invoice', payload: { invoice_id: id }, idempotencyKey: `process_invoice:${id}:po:${r.purchaseOrderId}` })),
    };
  },
  'GET /api/purchase-orders': async (c) => ({ data: await listPurchaseOrders(c.tx, c.caller.orgId) }),
  'POST /api/discrepancies/:id/investigate': async (c) => {
    const r = await requestInvestigation(c.tx, user(c), c.id, c.deps.model ?? 'unconfigured');
    return {
      status: 202, data: r.investigation,
      jobs: r.created ? [{ kind: 'investigate', payload: { investigation_id: r.investigation.id, discrepancy_id: c.id }, idempotencyKey: `investigate:${r.investigation.id}` }] : [],
    };
  },
  'GET /api/investigations/:id': async (c) => ({ data: await getInvestigation(c.tx, c.caller.orgId, c.id) }),
  'POST /api/discrepancies/:id/resolve': async (c) => ({ data: await resolveDiscrepancy(c.tx, user(c), c.id, ResolveRequest.parse(c.body ?? {})) }),
  'GET /api/discrepancies/:id/history': async (c) => ({ data: await discrepancyHistory(c.tx, c.caller.orgId, c.id) }),
  'POST /api/discrepancies/:id/draft-message': async (c) => {
    const req = DraftMessageRequest.parse(c.body ?? {});
    return { status: 201, data: await draftSupplierMessage(c.tx, c.caller.orgId, c.id, { actor: { type: 'user', id: c.caller.userId }, createdBy: c.caller.userId, requestedCorrection: req.requested_correction }) };
  },
};

const COMPILED = (Object.keys(ROUTES) as RouteKey[]).map((key) => {
  const [method, path] = key.split(' ');
  return { key, method, pattern: new RegExp(`^${path.replace(':id', '([^/]+)')}$`) };
});

const header = (h: HttpRequest['headers'], name: string) => {
  const v = Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(v) ? v[0] : v;
};
const digest = (s: string) => createHash('sha256').update(s).digest();
const secretMatches = (given: string | undefined, secret: string | undefined) =>
  !!secret && !!given && timingSafeEqual(digest(given), digest(`Bearer ${secret}`));

/** Maps any error to the envelope. Only ApiError messages reach the caller; database and runtime details never do. */
function toResponse(e: unknown): HttpResponse & { code: string } {
  let code: keyof typeof STATUS = 'internal', message = 'Internal error';
  const pgCode = (e as { code?: unknown })?.code;
  if (e instanceof ApiError) ({ code, message } = e);
  else if (e instanceof ZodError) { code = 'invalid_request'; message = `Invalid request: ${[...new Set(e.issues.map((i) => i.path.join('.') || '(body)'))].join(', ')}`.slice(0, 500); }
  else if (pgCode === '23505' || pgCode === '40001' || pgCode === '40P01') { code = 'conflict'; message = 'Conflicting change. Reload and try again.'; }
  else if (pgCode === '42501' || pgCode === '23503') { code = 'not_found'; message = 'Not found'; } // RLS/foreign-org: never reveal existence
  else if (pgCode === '22P02' || pgCode === '23514' || pgCode === '22003') { code = 'invalid_request'; message = 'Invalid request'; }
  return { status: STATUS[code], body: { error: { code, message } }, code };
}

export function createRouter(deps: Deps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));

  return async function route(req: HttpRequest): Promise<HttpResponse> {
    const started = Date.now(), requestId = randomUUID();
    const path = new URL(req.url, 'http://local').pathname;
    const match = COMPILED.map((r) => ({ r, m: req.method === r.method ? r.pattern.exec(path) : null })).find((x) => x.m);
    let caller: Caller | undefined;
    let res: HttpResponse;
    let replayed = false, kick = false;
    try {
      if (!match) notFound();
      const { key } = match!.r;
      const id = match!.m![1] ?? '';
      if (key === 'POST /api/jobs/run' || key === 'GET /api/jobs/run') {
        if (!secretMatches(header(req.headers, 'authorization'), deps.cronSecret)) fail('unauthenticated', 'Sign in required');
        res = { status: 200, body: { data: { results: await runJobs(deps.db, { now }) } } };
      } else if (key === 'GET /api/config') {
        // Only the supabase variant is ever served here; the dev variant exists only in scripts/dev-server.ts.
        if (!deps.publicConfig) fail('internal', 'Internal error');
        res = { status: 200, body: { data: { mode: 'supabase', supabase_url: deps.publicConfig!.supabase_url, supabase_anon_key: deps.publicConfig!.supabase_anon_key } } };
      } else {
        caller = await authenticate(deps.db, deps.verifyToken, header(req.headers, 'authorization'));
        if (RANK[caller.role] < RANK[ROUTES[key] as z.infer<typeof Role>]) fail('forbidden', 'Your role does not allow this action');
        if (id && !UUID.test(id)) notFound();
        const mutating = req.method !== 'GET';
        const idemKey = mutating ? IdempotencyKey.safeParse(header(req.headers, 'idempotency-key')) : null;
        if (idemKey && !idemKey.success) fail('invalid_request', 'A valid Idempotency-Key header is required');
        const c = caller;
        res = await deps.db.transaction(async (tx) => {
          const endpoint = `${req.method} ${path}`, requestHash = sha256(canonical(req.body ?? null));
          if (idemKey?.success) {
            // Per-user lock: concurrent requests from one user queue here, so the rate count and key checks are exact.
            await tx.query('select pg_advisory_xact_lock(hashtext($1))', [c.userId]);
            const [prior] = await tx.query<{ user_id: string; response: any; status_code: number }>(
              'select user_id, response, status_code from idempotency_keys where organization_id = $1 and key = $2 and endpoint = $3', [c.orgId, idemKey.data, endpoint]);
            if (prior) {
              if (prior.user_id !== c.userId || prior.response.request_hash !== requestHash) fail('conflict', 'This Idempotency-Key was already used for a different request.');
              replayed = true;
              return { status: prior.status_code, body: prior.response.body };
            }
            const [{ n }] = await tx.query<{ n: number }>(
              `select count(*)::int as n from idempotency_keys where user_id = $1 and created_at > now() - interval '1 minute'`, [c.userId]);
            if (n >= (deps.rateLimitPerMinute ?? 60)) fail('rate_limited', 'Too many requests. Try again in a minute.');
          }
          const out = await asUser(tx, c.userId, () => HANDLERS[key as keyof typeof HANDLERS]({ tx, caller: c, id, body: req.body, deps }));
          kick = (out.jobs ?? []).some((j) => j.kind === 'investigate');
          for (const j of out.jobs ?? []) await enqueue(tx, { organizationId: c.orgId, kind: j.kind, payload: j.payload, idempotencyKey: j.idempotencyKey, now: now() });
          const response = { status: out.status ?? 200, body: { data: out.data } };
          if (idemKey?.success) {
            await tx.query(
              `insert into idempotency_keys (organization_id, key, endpoint, user_id, response, status_code) values ($1, $2, $3, $4, $5::jsonb, $6)`,
              [c.orgId, idemKey.data, endpoint, c.userId, JSON.stringify({ request_hash: requestHash, body: response.body }), response.status]);
          }
          return response;
        });
        // Round-trip through JSON so a first response and its replay are byte-identical.
        res = { status: res.status, body: JSON.parse(JSON.stringify(res.body)) };
        // After commit, so the worker sees the job. The scheduled /api/jobs/run still sweeps anything this misses.
        if (kick && deps.defer) {
          deps.defer(() => runJobs(deps.db, { now }).catch((e) => log({ level: 'error', request_id: requestId, event: 'deferred_worker_failed', error_name: (e as Error)?.name ?? 'Error' })));
        }
      }
    } catch (e) {
      const r = toResponse(e);
      res = { status: r.status, body: r.body };
      if (r.code === 'internal') {
        const err = e as { name?: string; code?: unknown };
        log({ level: 'error', request_id: requestId, error_name: err?.name ?? 'Error', pg_code: typeof err?.code === 'string' ? err.code : undefined });
      }
    }
    log({
      level: res.status >= 500 ? 'error' : 'info', request_id: requestId, method: req.method, route: match?.r.key ?? 'unmatched', status: res.status,
      duration_ms: Date.now() - started, user_id: caller?.userId, org_id: caller?.orgId, replayed: replayed || undefined,
    });
    return res;
  };
}
