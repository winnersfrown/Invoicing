import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimJob, enqueue, finishJob, registerJobHandler, runJobs } from '../../server/services/jobs';
import { invoiceBody, poBody, setup, T0, type Env } from '../api/helpers';

let env: Env;
let orgId: string;
beforeAll(async () => { env = await setup(); orgId = (await env.newOrg()).id; });
afterAll(async () => env.close());

const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const job = async (id: string) => (await env.db.query<any>('select * from jobs where id = $1', [id]))[0];
const newJob = (kind: string, maxAttempts = 3) =>
  enqueue(env.db, { organizationId: orgId, kind, payload: { n: 1 }, idempotencyKey: `${kind}:${randomUUID()}`, maxAttempts, now: T0 });

describe('jobs', () => {
  it('enqueue is idempotent on its key', async () => {
    const input = { organizationId: orgId, kind: 'noop', payload: {}, idempotencyKey: `k:${randomUUID()}`, now: T0 };
    const [x, y] = [await enqueue(env.db, input), await enqueue(env.db, input)];
    expect(y.id).toBe(x.id);
    await env.db.query(`update jobs set status = 'succeeded' where id = $1`, [x.id]);
  });

  it('retries a failed job after backoff, then succeeds', async () => {
    let calls = 0;
    registerJobHandler('flaky', async () => { calls++; if (calls === 1) throw new Error('temporary outage'); });
    const j = await newJob('flaky');
    expect((await runJobs(env.db, { now: () => T0 })).find((r) => r.id === j.id)?.status).toBe('queued');
    const failed = await job(j.id);
    expect(failed).toMatchObject({ status: 'queued', attempts: 1, last_error: 'temporary outage', locked_until: null });
    expect(new Date(failed.run_after).getTime()).toBeGreaterThan(T0.getTime());
    await runJobs(env.db, { now: () => at(1) });
    expect(calls).toBe(1); // still backing off
    await runJobs(env.db, { now: () => at(3600) });
    expect(calls).toBe(2);
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', attempts: 2, last_error: null });
  });

  it('marks a job failed after max attempts', async () => {
    registerJobHandler('broken', async () => { throw new Error('always'); });
    const j = await newJob('broken', 2);
    await runJobs(env.db, { now: () => T0 });
    await runJobs(env.db, { now: () => at(3600) });
    expect(await job(j.id)).toMatchObject({ status: 'failed', attempts: 2 });
    await runJobs(env.db, { now: () => at(7200) });
    expect((await job(j.id)).attempts).toBe(2);
  });

  it('reclaims an expired lease and ignores the stale worker\'s completion', async () => {
    let calls = 0;
    registerJobHandler('slow', async () => { calls++; });
    const j = await newJob('slow');
    const stale = await claimJob(env.db, T0, 60_000); // a worker that claimed and then died
    expect(stale?.id).toBe(j.id);
    await runJobs(env.db, { now: () => at(30) });
    expect(calls).toBe(0); // lease still held
    await runJobs(env.db, { now: () => at(61) });
    expect(calls).toBe(1);
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    await finishJob(env.db, stale!, at(62), new Error('late failure from the dead worker'));
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', attempts: 2, last_error: null });
  });

  it('two concurrent workers never run the same job twice', async () => {
    let calls = 0;
    registerJobHandler('once', async () => { calls++; await new Promise((r) => setTimeout(r, 20)); });
    const jobsCreated = await Promise.all([newJob('once'), newJob('once'), newJob('once')]);
    await Promise.all([runJobs(env.db, { now: () => T0 }), runJobs(env.db, { now: () => T0 })]);
    expect(calls).toBe(3);
    for (const j of jobsCreated) expect(await job(j.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('process_invoice revalidates an invoice once its PO exists', async () => {
    const org = await env.newOrg();
    await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody({ purchase_order_number: 'PO-OTHER' }) });
    const inv = await env.call('POST', '/api/invoices', { user: org.reviewer, body: invoiceBody({ po_reference: 'PO-1001' }) });
    expect(inv.body.data.purchase_order_id).toBeNull();
    await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody() });
    await runJobs(env.db, { now: () => at(10) });
    const types = (await env.call('GET', `/api/invoices/${inv.body.data.id}/discrepancies`, { user: org.viewer })).body.data
      .map((d: { discrepancy_type: string; status: string }) => `${d.discrepancy_type}:${d.status}`).sort();
    expect(types).toEqual(['missing_purchase_order:dismissed', 'unit_price_mismatch:open']);
    const [actor] = await env.db.query<{ actor_type: string }>(
      `select actor_type from audit_events where target_id = $1 and event_type = 'invoice.linked' and new_state ->> 'purchase_order_id' is not null`, [inv.body.data.id]);
    expect(actor.actor_type).toBe('system');
  });
});
