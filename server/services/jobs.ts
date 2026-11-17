// Durable jobs in Postgres: idempotent enqueue, claim with FOR UPDATE SKIP LOCKED, lease, retry with backoff.
// Always called on the privileged connection (authenticated has no access to `jobs`).
import type { Db } from '../db/index';
import { SYSTEM } from './audit';
import { processInvoice } from './validation';

export type Job = {
  id: string; organization_id: string; kind: string; payload: any; idempotency_key: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number; max_attempts: number; run_after: Date; locked_until: Date | null; last_error: string | null;
};
export type JobHandler = (db: Db, job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();
/** Registers (or replaces) the handler for a job kind. The agent package registers 'investigate'. */
export function registerJobHandler(kind: string, fn: JobHandler): void { handlers.set(kind, fn); }

registerJobHandler('process_invoice', async (db, job) => { await processInvoice(db, job.organization_id, job.payload.invoice_id, SYSTEM); });
registerJobHandler('investigate', async () => { throw new Error('No investigate handler is registered'); });

export async function enqueue(db: Db, j: { organizationId: string; kind: string; payload: unknown; idempotencyKey: string; maxAttempts?: number; now?: Date }): Promise<Job> {
  const now = (j.now ?? new Date()).toISOString();
  const [created] = await db.query<Job>(
    `insert into jobs (organization_id, kind, payload, idempotency_key, status, attempts, max_attempts, run_after)
     values ($1, $2, $3::jsonb, $4, 'queued', 0, $5, $6::timestamptz) on conflict (idempotency_key) do nothing returning *`,
    [j.organizationId, j.kind, JSON.stringify(j.payload), j.idempotencyKey, j.maxAttempts ?? 3, now]);
  return created ?? (await db.query<Job>('select * from jobs where idempotency_key = $1', [j.idempotencyKey]))[0];
}

/** Claims the next due job (queued and due, or running with an expired lease) and leases it until now + leaseMs. */
export async function claimJob(db: Db, now: Date, leaseMs: number): Promise<Job | null> {
  const [job] = await db.query<Job>(
    `update jobs set status = 'running', attempts = attempts + 1, locked_until = $2::timestamptz
     where id = (
       select id from jobs
       where attempts < max_attempts and ((status = 'queued' and run_after <= $1::timestamptz) or (status = 'running' and locked_until < $1::timestamptz))
       order by run_after, created_at limit 1 for update skip locked)
     returning *`, [now.toISOString(), new Date(now.getTime() + leaseMs).toISOString()]);
  return job ?? null;
}

const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);

/** Records the outcome. The attempt number fences out a worker whose lease expired and was reclaimed. */
export async function finishJob(db: Db, job: Job, now: Date, error?: unknown): Promise<Job['status']> {
  const status = !error ? 'succeeded' : job.attempts >= job.max_attempts ? 'failed' : 'queued';
  const message = error ? String((error as Error)?.message ?? error).slice(0, 500) : null;
  await db.query(
    `update jobs set status = $3, locked_until = null, last_error = $4, run_after = $5::timestamptz
     where id = $1 and status = 'running' and attempts = $2`,
    [job.id, job.attempts, status, message, new Date(now.getTime() + (status === 'queued' ? backoffMs(job.attempts) : 0)).toISOString()]);
  return status;
}

/** Runs due jobs one at a time until none are left or `max` have run. */
export async function runJobs(db: Db, o: { now?: () => Date; max?: number; leaseMs?: number } = {}) {
  const now = o.now ?? (() => new Date());
  // Expired leases that have used every attempt will never be claimed again: close them.
  await db.query(`update jobs set status = 'failed', locked_until = null, last_error = coalesce(last_error, 'Lease expired on the final attempt')
                  where status = 'running' and locked_until < $1::timestamptz and attempts >= max_attempts`, [now().toISOString()]);
  const results: { id: string; kind: string; status: Job['status']; attempts: number }[] = [];
  for (let n = 0; n < (o.max ?? 10); n++) {
    const job = await claimJob(db, now(), o.leaseMs ?? 300_000);
    if (!job) break;
    const handler = handlers.get(job.kind);
    let error: unknown = handler ? undefined : new Error(`No handler for job kind ${job.kind}`);
    if (handler) { try { await handler(db, job); } catch (e) { error = e; } }
    results.push({ id: job.id, kind: job.kind, status: await finishJob(db, job, now(), error), attempts: job.attempts });
  }
  return results;
}
