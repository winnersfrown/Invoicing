// Phase 0 isolation, authorization and audit checks through the real router. All documents are synthetic.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '../../server/contracts/index';
import { invoiceBody, poBody, setup, type Env } from './helpers';

let env: Env;
type Org = Awaited<ReturnType<Env['newOrg']>>;
let a: Org, b: Org;
let A: { invoice: string; po: string; discrepancy: string; investigation: string; draft: string };

beforeAll(async () => {
  env = await setup();
  [a, b] = [await env.newOrg(), await env.newOrg()];
  for (const o of [a, b]) await env.call('POST', '/api/purchase-orders', { user: o.reviewer, body: poBody() });
  const inv = await env.call('POST', '/api/invoices', { user: a.reviewer, body: invoiceBody() });
  const pos = await env.call('GET', '/api/purchase-orders', { user: a.viewer });
  const ds = await env.call('GET', `/api/invoices/${inv.body.data.id}/discrepancies`, { user: a.viewer });
  const d = ds.body.data.find((x: any) => x.discrepancy_type === 'unit_price_mismatch');
  const inves = await env.call('POST', `/api/discrepancies/${d.id}/investigate`, { user: a.reviewer });
  const draft = await env.call('POST', `/api/discrepancies/${d.id}/draft-message`, { user: a.reviewer, body: { requested_correction: 'Reissue' } });
  A = { invoice: inv.body.data.id, po: pos.body.data[0].id, discrepancy: d.id, investigation: inves.body.data.id, draft: draft.body.data.id };
});
afterAll(async () => env?.close());

const bodies = (): Record<string, unknown> => ({
  'POST /api/invoices/:id/review-fields': { updated_at: '2026-01-01T00:00:00.000Z', values: { currency: 'USD' } },
  'POST /api/invoices/:id/review-line-match': { purchase_order_id: A.po, invoice_line_id: randomUUID(), po_line_id: randomUUID(), decision: 'confirm' },
  'POST /api/invoices/:id/unlink-purchase-order': { purchase_order_id: A.po },
  'POST /api/discrepancies/:id/resolve': { decision: 'more_info_requested', notes: 'x' },
  'POST /api/discrepancies/:id/draft-message': { requested_correction: 'x' },
});
const target = (path: string) => path.startsWith('/api/investigations') ? A.investigation : path.startsWith('/api/discrepancies') ? A.discrepancy : A.invoice;

// Routes come from ROUTES so a newly added route fails the coverage test until it is handled here.
const userRoutes = Object.entries(ROUTES).filter(([, r]) => ['admin', 'reviewer', 'viewer'].includes(r)).map(([k]) => k);
const idRoutes = userRoutes.filter((r) => r.includes(':id'));
const mutatingIdRoutes = idRoutes.filter((r) => r.startsWith('POST'));
const COVERED_CREATES = ['POST /api/invoices', 'POST /api/purchase-orders'];

describe('route coverage', () => {
  it('knows every mutating user route', () => {
    expect(userRoutes.filter((r) => r.startsWith('POST')).sort()).toEqual([...COVERED_CREATES, ...mutatingIdRoutes].sort());
    expect([...mutatingIdRoutes].sort()).toEqual([
      'POST /api/discrepancies/:id/draft-message', 'POST /api/discrepancies/:id/investigate', 'POST /api/discrepancies/:id/resolve',
      'POST /api/invoices/:id/archive', 'POST /api/invoices/:id/process', 'POST /api/invoices/:id/restore',
      'POST /api/invoices/:id/review-fields', 'POST /api/invoices/:id/review-line-match', 'POST /api/invoices/:id/unlink-purchase-order',
    ]);
  });
});

describe('cross-organisation access', () => {
  it.each(idRoutes)('%s: B gets not_found identical to a missing id, for every role', async (route) => {
    const [method, path] = route.split(' ');
    for (const role of ['admin', 'reviewer', 'viewer'] as const) {
      const body = bodies()[route] ?? {};
      const foreign = await env.call(method, path.replace(':id', target(path)), { user: b[role], body });
      if (method === 'POST' && role === 'viewer') { expect(foreign.body.error.code).toBe('forbidden'); continue; }
      const missing = await env.call(method, path.replace(':id', randomUUID()), { user: b[role], body });
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
      expect(foreign.body).toEqual(missing.body);
    }
  });

  it('lists, archived lists and PO lists never show A rows to B', async () => {
    for (const url of ['/api/invoices', '/api/invoices/archived', '/api/purchase-orders']) {
      const r = await env.call('GET', url, { user: b.viewer });
      expect(JSON.stringify(r.body)).not.toContain(A.invoice);
      expect(JSON.stringify(r.body)).not.toContain(A.po);
    }
    expect((await env.call('GET', '/api/invoices', { user: b.viewer })).body.data).toEqual([]);
  });

  it('B cannot reach A documents, drafts or investigations', async () => {
    const own = await env.call('GET', `/api/invoices/${A.invoice}`, { user: a.viewer });
    expect(own.body.data.document_url).toMatch(/^https:\/\//);
    expect((await env.call('GET', `/api/invoices/${A.invoice}`, { user: b.admin })).status).toBe(404);
    expect((await env.call('GET', `/api/investigations/${A.investigation}`, { user: b.admin })).status).toBe(404);
    // drafts have no read route; draft-message must not create or echo one for B
    expect((await env.call('POST', `/api/discrepancies/${A.discrepancy}/draft-message`, { user: b.admin, body: { requested_correction: 'x' } })).status).toBe(404);
    expect(await env.db.query('select organization_id from supplier_message_drafts where id = $1', [A.draft])).toEqual([{ organization_id: a.id }]);
    expect(await env.db.query('select 1 from supplier_message_drafts where organization_id = $1', [b.id])).toEqual([]);
  });

  it('foreign ids smuggled in request bodies are refused', async () => {
    const mine = (await env.call('POST', '/api/invoices', { user: b.reviewer, body: invoiceBody({ invoice_number: 'B-S' }) })).body.data;
    const unlink = await env.call('POST', `/api/invoices/${mine.id}/unlink-purchase-order`, { user: b.reviewer, body: { purchase_order_id: A.po } });
    expect([404, 409]).toContain(unlink.status);
    const lm = await env.call('POST', `/api/invoices/${mine.id}/review-line-match`, { user: b.reviewer, body: { ...bodies()['POST /api/invoices/:id/review-line-match'] as object } });
    expect([404, 409]).toContain(lm.status);
    expect((await env.call('POST', '/api/invoices', { user: b.reviewer, body: invoiceBody({ invoice_number: 'B-2' }, { supersedes_invoice_id: A.invoice }) })).status).toBe(404);
    const [n] = await env.db.query<{ n: number }>('select count(*)::int n from invoices where organization_id = $1 and purchase_order_id = $2', [a.id, A.po]);
    expect(n.n).toBe(1);
  });

  it('a failed cross-org mutation changes nothing and writes no audit row for B', async () => {
    for (const route of mutatingIdRoutes) {
      const [method, path] = route.split(' ');
      await env.call(method, path.replace(':id', target(path)), { user: b.admin, body: bodies()[route] ?? {} });
    }
    expect(await env.db.query('select 1 from audit_events where organization_id = $1 and target_id in ($2, $3)', [b.id, A.invoice, A.discrepancy])).toEqual([]);
    const [row] = await env.db.query<{ archived_at: unknown; purchase_order_id: string | null }>('select archived_at, purchase_order_id from invoices where id = $1', [A.invoice]);
    expect(row).toEqual({ archived_at: null, purchase_order_id: A.po });
  });
});

describe('role enforcement', () => {
  it.each(mutatingIdRoutes)('viewer cannot call %s on own-org rows', async (route) => {
    const [method, path] = route.split(' ');
    const r = await env.call(method, path.replace(':id', target(path)), { user: a.viewer, body: bodies()[route] ?? {} });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
  });
  it.each(COVERED_CREATES)('viewer cannot call %s', async (route) => {
    const body = route.endsWith('invoices') ? invoiceBody({ invoice_number: 'V-1' }) : poBody({ purchase_order_number: 'V-1' });
    expect((await env.call('POST', route.split(' ')[1], { user: a.viewer, body })).status).toBe(403);
  });
  it('forbidden attempts change nothing', async () => {
    const [row] = await env.db.query<{ archived_at: unknown }>('select archived_at from invoices where id = $1', [A.invoice]);
    expect(row.archived_at).toBeNull();
    expect(await env.db.query(`select 1 from audit_events where organization_id = $1 and actor_id = $2`, [a.id, a.viewer])).toEqual([]);
  });
});

describe('audit trail', () => {
  const events = (orgId: string, type: string, target?: string) => env.db.query<any>(
    `select * from audit_events where organization_id = $1 and event_type = $2 ${target ? 'and target_id = $3' : ''} order by id`,
    target ? [orgId, type, target] : [orgId, type]);

  it('upload, PO, process, field review, resolve, unlink, archive and restore are audited with actor and org', async () => {
    const org = await env.newOrg();
    const po = (await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody() })).body.data;
    const inv = (await env.call('POST', '/api/invoices', { user: org.reviewer, body: invoiceBody() })).body.data;
    const post = async (action: string, body: unknown = {}, user = org.reviewer) => {
      const r = await env.call('POST', `/api/invoices/${inv.id}/${action}`, { user, body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data;
    };
    const price = (await env.call('GET', `/api/invoices/${inv.id}/discrepancies`, { user: org.viewer })).body.data
      .find((x: any) => x.discrepancy_type === 'unit_price_mismatch');

    const before = (await env.db.query('select 1 from audit_events where organization_id = $1', [org.id])).length;
    await post('process', {}, org.admin);
    // a no-change reprocess may write nothing; anything it writes must carry the admin and the org
    for (const e of await env.db.query<any>('select * from audit_events where organization_id = $1 order by id offset $2', [org.id, before])) {
      expect(e).toMatchObject({ actor_type: 'user', actor_id: org.admin, organization_id: org.id });
    }
    expect((await env.call('POST', `/api/discrepancies/${price.id}/resolve`, { user: org.reviewer, body: { decision: 'more_info_requested', notes: 'Check price' } })).status).toBe(200);
    const fresh = (await env.call('GET', `/api/invoices/${inv.id}`, { user: org.viewer })).body.data;
    await post('review-fields', { updated_at: fresh.updated_at, values: { supplier_name: 'Northwind Supplies LLC' } });
    await post('unlink-purchase-order', { purchase_order_id: po.id });
    await post('archive');
    await post('restore');

    const expected: [string, string | undefined][] = [
      ['invoice.created', inv.id], ['purchase_order.created', po.id], ['resolution.recorded', undefined], ['invoice.fields_reviewed', inv.id],
      ['invoice.purchase_order_unlinked', inv.id], ['invoice.archived', inv.id], ['invoice.restored', inv.id],
    ];
    for (const [type, id] of expected) {
      const rows = await events(org.id, type, id);
      expect(rows.length, type).toBeGreaterThan(0);
      for (const e of rows) expect(e, type).toMatchObject({ organization_id: org.id, actor_type: 'user', actor_id: org.reviewer });
    }
    expect(await env.db.query('select 1 from audit_events where organization_id = $1 and target_id = $2', [b.id, inv.id])).toEqual([]);
  });

  it('line-match review is audited with the reviewer as actor, and B cannot review it', async () => {
    const org = await env.newOrg();
    const item = (sku: string, description: string, q: number, p: number) => ({ sku, description, quantity: q, unit_price: p.toFixed(2), line_total: (q * p).toFixed(2), tax_amount: null });
    await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody({ tax_amount: '0.00', total_amount: '540.00', lines: [item('LG-001', 'Logo (Design)', 1, 500), item('BN-002', 'Banner (2x6m)', 1, 40)] }) });
    const inv = (await env.call('POST', '/api/invoices', { user: org.reviewer, body: invoiceBody({ subtotal: '545.00', total_amount: '545.00', tax_amount: '0.00', lines: [item('LGO-001', 'Logo', 1, 500), item('BAN-002', 'Banner (2x6m)', 1, 45)] }) })).body.data;
    const ds = (await env.call('GET', `/api/invoices/${inv.id}/discrepancies`, { user: org.viewer })).body.data;
    const pending = ds.find((d: any) => d.deterministic_evidence?.check === 'line_match_review' && d.status === 'open');
    expect(pending, 'fixture should produce a pending line match').toBeTruthy();
    const c = pending.deterministic_evidence.candidates[0];
    const body = { purchase_order_id: inv.purchase_order_id, invoice_line_id: c.invoice_line_id, po_line_id: c.po_line_id, decision: 'confirm' };
    expect((await env.call('POST', `/api/invoices/${inv.id}/review-line-match`, { user: b.reviewer, body })).status).toBe(404);
    expect((await env.call('POST', `/api/invoices/${inv.id}/review-line-match`, { user: org.viewer, body })).status).toBe(403);
    expect(await events(org.id, 'invoice.line_match_reviewed', inv.id)).toEqual([]);
    const r = await env.call('POST', `/api/invoices/${inv.id}/review-line-match`, { user: org.reviewer, body });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = await events(org.id, 'invoice.line_match_reviewed', inv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: org.reviewer, organization_id: org.id });
  });

  it('audit rows cannot be updated, deleted or truncated, even by the privileged connection', async () => {
    const [row] = await env.db.query<{ id: string }>('select id from audit_events where organization_id = $1 limit 1', [a.id]);
    await expect(env.db.query(`update audit_events set event_type = 'forged' where id = $1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(env.db.query('delete from audit_events where id = $1', [row.id])).rejects.toThrow(/append-only/);
    await expect(env.db.query('truncate audit_events cascade')).rejects.toThrow(/append-only/);
  });
});

describe('supplier mismatch never links silently', () => {
  it('same PO number, different supplier: unlinked, supplier_mismatch finding, stays unlinked on reprocess', async () => {
    const org = await env.newOrg();
    await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody({ supplier_name: 'Alder Freight GmbH', purchase_order_number: 'PO-7777' }) });
    const inv = (await env.call('POST', '/api/invoices', { user: org.reviewer, body: invoiceBody({ supplier_name: 'Birch Components Ltd', po_reference: 'PO-7777', invoice_number: 'SM-1' }) })).body.data;
    expect(inv.purchase_order_id).toBeNull();
    const ds = (await env.call('GET', `/api/invoices/${inv.id}/discrepancies`, { user: org.viewer })).body.data;
    expect(ds.map((d: any) => d.discrepancy_type)).toContain('supplier_mismatch');
    expect((await env.call('POST', `/api/invoices/${inv.id}/process`, { user: org.reviewer })).body.data.purchase_order_id).toBeNull();
    // a matching PO that exists only in another organisation is never considered
    await env.call('POST', '/api/purchase-orders', { user: b.reviewer, body: poBody({ supplier_name: 'Birch Components Ltd', purchase_order_number: 'PO-7777' }) });
    expect((await env.call('POST', `/api/invoices/${inv.id}/process`, { user: org.reviewer })).body.data.purchase_order_id).toBeNull();
  });
});
