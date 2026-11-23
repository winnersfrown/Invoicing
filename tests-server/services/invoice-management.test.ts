import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from '../../server/db/index';
import { runJobs } from '../../server/services/jobs';
import { extracted, invoiceBody, poBody, setup, type Env } from '../api/helpers';

let env: Env;
beforeAll(async () => { env = await setup(); });
afterAll(async () => env?.close());

type Org = Awaited<ReturnType<Env['newOrg']>>;
const path = (id: string, action?: string) => `/api/invoices/${id}${action ? '/' + action : ''}`;
const read = async (url: string, user: string) => {
  const r = await env.call('GET', url, { user });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
const create = async (url: string, org: Org, body: unknown) => {
  const r = await env.call('POST', url, { user: org.reviewer, body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data;
};
const post = (org: Org, id: string, action: string, body = {}, user = org.reviewer) =>
  env.call('POST', path(id, action), { user, body });
const change = async (org: Org, id: string, action: string, body = {}) => {
  const r = await post(org, id, action, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
const openFindings = async (org: Org, id: string) =>
  (await read(path(id, 'discrepancies'), org.reviewer)).filter((d: any) => !['dismissed', 'resolved'].includes(d.status));

describe('invoice management', () => {
  it('archives and restores the original invoice, fields, findings, decisions, and document', async () => {
    const org = await env.newOrg();
    await create('/api/purchase-orders', org, poBody());
    const inv = await create('/api/invoices', org, invoiceBody());
    const [price] = await openFindings(org, inv.id);
    const decision = await env.call('POST', `/api/discrepancies/${price.id}/resolve`, {
      user: org.reviewer, body: { decision: 'more_info_requested', notes: 'Verify the printed unit price.' },
    });
    expect(decision.status).toBe(200);
    const resolutionHistory = `/api/discrepancies/${price.id}/history`;
    const before = await read(path(inv.id), org.reviewer);
    const findings = await read(path(inv.id, 'discrepancies'), org.reviewer);
    const history = await read(resolutionHistory, org.reviewer);

    const archived = await change(org, inv.id, 'archive');
    expect(archived).toMatchObject({ archived_at: expect.any(String), archived_by: org.reviewer, status: before.status });
    expect(await read('/api/invoices', org.reviewer)).toEqual([]);
    expect(await read('/api/invoices/archived', org.reviewer)).toMatchObject([{ id: inv.id }]);
    expect(await read(path(inv.id), org.reviewer)).toMatchObject({
      document_url: expect.stringMatching(/^https:\/\//), extraction: before.extraction, lines: before.lines,
      total_amount: before.total_amount, purchase_order_id: before.purchase_order_id,
    });
    expect(await read(path(inv.id, 'discrepancies'), org.reviewer)).toEqual(findings);
    expect(await read(resolutionHistory, org.reviewer)).toEqual(history);
    expect((await post(org, inv.id, 'process')).status).toBe(409);
    expect((await post(org, inv.id, 'unlink-purchase-order', { purchase_order_id: inv.purchase_order_id })).status).toBe(409);

    const restored = await change(org, inv.id, 'restore');
    expect(restored).toMatchObject({ archived_at: null, archived_by: null, purchase_order_id: before.purchase_order_id });
    expect(await read('/api/invoices/archived', org.reviewer)).toEqual([]);
    expect(await read('/api/invoices', org.reviewer)).toMatchObject([{ id: inv.id }]);
    expect(await read(resolutionHistory, org.reviewer)).toEqual(history);
    const events = await read(path(inv.id, 'history'), org.reviewer);
    expect(events).toMatchObject([
      { event_type: 'invoice.restored', actor_id: org.reviewer, new_state: { archived_at: null, archived_by: null } },
      { event_type: 'invoice.archived', actor_id: org.reviewer, new_state: { archived_by: org.reviewer } },
    ]);
    expect(new Date(events[0].previous_state.archived_at).toISOString()).toBe(archived.archived_at);
    expect(new Date(events[1].new_state.archived_at).toISOString()).toBe(archived.archived_at);
  });

  it('protects management actions and archived records across roles and organizations', async () => {
    const org = await env.newOrg(), other = await env.newOrg();
    const po = await create('/api/purchase-orders', org, poBody());
    const inv = await create('/api/invoices', org, invoiceBody());
    const unlink = { purchase_order_id: po.id };
    expect((await post(org, inv.id, 'unlink-purchase-order', unlink, randomUUID())).status).toBe(403);
    expect((await post(org, inv.id, 'archive', {}, randomUUID())).status).toBe(403);
    expect((await post(org, inv.id, 'unlink-purchase-order', unlink, other.reviewer)).status).toBe(404);
    expect((await post(org, inv.id, 'archive', {}, other.reviewer)).status).toBe(404);
    await change(org, inv.id, 'archive');
    expect((await post(org, inv.id, 'restore', {}, randomUUID())).status).toBe(403);
    expect((await post(org, inv.id, 'restore', {}, other.reviewer)).status).toBe(404);
    expect(await read('/api/invoices/archived', other.reviewer)).toEqual([]);
    expect((await env.call('GET', path(inv.id, 'history'), { user: other.reviewer })).status).toBe(404);
    expect((await env.call('DELETE', path(inv.id), { user: other.reviewer })).status).toBe(404);
    expect(await read('/api/invoices/archived', org.reviewer)).toMatchObject([{ id: inv.id }]);
  });

  it('unlinks an exact pair, closes PO-dependent findings, and keeps the PO and its other links', async () => {
    const org = await env.newOrg();
    const po = await create('/api/purchase-orders', org, poBody());
    const inv = await create('/api/invoices', org, invoiceBody());
    const other = await create('/api/invoices', org, invoiceBody({ invoice_number: 'INV-OTHER' }));
    const [price] = await openFindings(org, inv.id);
    expect(price.discrepancy_type).toBe('unit_price_mismatch');
    const body = { purchase_order_id: po.id };
    expect(await change(org, inv.id, 'unlink-purchase-order', body)).toMatchObject({ purchase_order_id: null, po_reference: 'PO-1001' });
    expect(await openFindings(org, inv.id)).toMatchObject([{ deterministic_evidence: { check: 'po_manually_unlinked' } }]);
    expect(await read(path(inv.id, 'discrepancies'), org.reviewer)).toContainEqual(expect.objectContaining({ id: price.id, status: 'dismissed' }));
    expect(await read('/api/purchase-orders', org.reviewer)).toMatchObject([{ id: po.id, total_amount: '480.00' }]);
    expect(await read(path(other.id), org.reviewer)).toMatchObject({ purchase_order_id: po.id });
    expect(await read(path(inv.id, 'history'), org.reviewer)).toMatchObject([{
      event_type: 'invoice.purchase_order_unlinked', actor_id: org.reviewer, timestamp: expect.any(String),
      previous_state: { purchase_order_id: po.id }, new_state: { purchase_order_id: null },
    }]);
    expect((await post(org, inv.id, 'unlink-purchase-order', body)).status).toBe(409);

    expect(await change(org, inv.id, 'process')).toMatchObject({ purchase_order_id: null });
    await change(org, inv.id, 'archive');
    expect(await change(org, inv.id, 'restore')).toMatchObject({ purchase_order_id: null });
    await expect(env.db.transaction(tx => asUser(tx, org.reviewer, () =>
      tx.query('update invoices set purchase_order_id = $1 where id = $2', [po.id, inv.id]))))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('holds an identical reference with conflicting or uncertain suppliers until verified', async () => {
    const org = await env.newOrg();
    const po = await create('/api/purchase-orders', org, poBody({
      supplier_name: 'Juliana Silva', purchase_order_number: 'PO-2030-042',
    }));
    const inv = await create('/api/invoices', org, invoiceBody({ supplier_name: 'Morgan Maxwell', po_reference: 'PO-2030-042' }));
    expect(inv.purchase_order_id).toBeNull();
    expect(await openFindings(org, inv.id)).toMatchObject([{
      discrepancy_type: 'supplier_mismatch', observed_value: 'Morgan Maxwell', expected_value: 'Juliana Silva',
      deterministic_evidence: { check: 'po_supplier_identity', review: false },
    }]);
    const exactButUncertain = await create('/api/invoices', org, invoiceBody({
      invoice_number: 'UNCONFIRMED', supplier_name: 'Juliana Silva', po_reference: 'PO-2030-042',
      extraction: { ...extracted().extraction, uncertain: ['supplier_name'] },
    }));
    expect(exactButUncertain.purchase_order_id).toBeNull();
    expect(await change(org, exactButUncertain.id, 'review-fields', {
      updated_at: exactButUncertain.updated_at, values: { supplier_name: 'Juliana Silva' },
    })).toMatchObject({ purchase_order_id: po.id });
    expect(await openFindings(org, exactButUncertain.id)).toMatchObject([{ discrepancy_type: 'unit_price_mismatch' }]);
  });

  it('excludes archived invoices from duplicate detection and rechecks active warnings', async () => {
    const org = await env.newOrg();
    const first = await create('/api/invoices', org, invoiceBody());
    const second = await create('/api/invoices', org, invoiceBody({ source_text: 'Second scan' }));
    expect((await read(path(second.id, 'duplicate-candidates'), org.reviewer)).candidates).toMatchObject([{ other_invoice_id: first.id }]);
    await change(org, first.id, 'archive');
    expect((await read(path(first.id, 'duplicate-candidates'), org.reviewer)).candidates).toEqual([]);
    expect((await read(path(second.id, 'duplicate-candidates'), org.reviewer)).candidates).toEqual([]);
    await runJobs(env.db, { now: () => new Date('2026-11-15T12:01:00Z') });
    expect((await openFindings(org, second.id)).map((d: any) => d.discrepancy_type)).not.toContain('duplicate_candidate');
    await change(org, first.id, 'restore');
    expect((await read(path(first.id, 'duplicate-candidates'), org.reviewer)).candidates).toMatchObject([{ other_invoice_id: second.id }]);
    expect((await openFindings(org, first.id)).map((d: any) => d.discrepancy_type)).toContain('duplicate_candidate');
  });

  it('skips matching archived invoices when their PO arrives and rechecks on restoration', async () => {
    const org = await env.newOrg();
    const inv = await create('/api/invoices', org, invoiceBody());
    expect(await openFindings(org, inv.id)).toMatchObject([{ discrepancy_type: 'missing_purchase_order', observed_value: 'PO-1001' }]);
    await change(org, inv.id, 'archive');
    const po = await create('/api/purchase-orders', org, poBody());
    expect(await env.db.query('select id from jobs where organization_id = $1 and kind = $2', [org.id, 'process_invoice'])).toEqual([]);
    expect(await read(path(inv.id), org.reviewer)).toMatchObject({ purchase_order_id: null });
    expect(await change(org, inv.id, 'restore')).toMatchObject({ purchase_order_id: po.id });
  });
});
