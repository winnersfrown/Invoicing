import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRouter } from '../../server/http/router';
import { invoiceBody, setup, type Env } from './helpers';

let env: Env;
beforeAll(async () => { env = await setup(); });
afterAll(async () => env.close());

it('provisions separate sample workspaces for verified accounts, once per account', async () => {
  const a = randomUUID(), b = randomUUID();
  const route = createRouter({ db: env.db, storage: env.storage, verifyToken: async () => null,
    verifyWorkspaceToken: async (token) => token === a || token === b ? token : null, log: () => {} });
  const provision = (token: string) => route({ method: 'POST', url: '/api/workspace', headers: { authorization: `Bearer ${token}` } });
  expect((await provision('unverified')).status).toBe(401);
  const results = await Promise.all([provision(a), provision(a), provision(b)]);
  for (const result of results) expect(result).toEqual({ status: 200, body: { data: { role: 'reviewer' } } });

  const invoices = async (user: string) => (await env.call('GET', '/api/invoices', { user })).body.data;
  const [fromA] = await invoices(a), [fromB] = await invoices(b);
  expect(await invoices(a)).toHaveLength(1);
  expect(await invoices(b)).toHaveLength(1);
  expect(fromA).toMatchObject({ invoice_number: 'NS-1068', total_amount: '660.00', status: 'exception' });
  expect(fromB.id).not.toEqual(fromA.id);
  expect((await env.call('GET', '/api/purchase-orders', { user: a })).body.data).toEqual([
    expect.objectContaining({ purchase_order_number: 'PO-2026-042', total_amount: '600.00' }),
  ]);
  const [poA] = (await env.call('GET', '/api/purchase-orders', { user: a })).body.data;
  expect((await env.call('GET', `/api/purchase-orders/${poA.id}`, { user: a })).body.data.lines).toHaveLength(2);
  expect((await env.call('GET', `/api/purchase-orders/${poA.id}`, { user: b })).status).toBe(404);
  const findingsPath = '/api/workspace/findings?kind=discrepancies';
  const activityPath = '/api/workspace/activity';
  const findingsA = (await env.call('GET', findingsPath, { user: a })).body.data;
  const findingsB = (await env.call('GET', findingsPath, { user: b })).body.data;
  expect(findingsA).toContainEqual(expect.objectContaining({ invoice_id: fromA.id, difference_amount: '60.00' }));
  expect(findingsB).toContainEqual(expect.objectContaining({ invoice_id: fromB.id, difference_amount: '60.00' }));
  expect(findingsB.every((finding: { invoice_id: string }) => finding.invoice_id === fromB.id)).toBe(true);
  expect((await env.call('GET', '/api/workspace/findings?kind=duplicates', { user: a })).body.data).toEqual([]);
  expect((await env.call('GET', '/api/workspace/findings?kind=invalid', { user: a })).status).toBe(400);
  expect((await env.call('GET', `${activityPath}?before=9223372036854775808`, { user: a })).status).toBe(400);

  const [priceFinding] = findingsA.filter((finding: { difference_amount: string }) => finding.difference_amount === '60.00');
  const notes = 'Verified 12 cases against the original purchase order.';
  const decision = await env.call('POST', `/api/discrepancies/${priceFinding.id}/resolve`, { user: a,
    body: { decision: 'more_info_requested', notes } });
  expect(decision.status).toBe(200);
  expect((await provision(a)).status).toBe(200);
  const activityA = (await env.call('GET', activityPath, { user: a })).body.data;
  expect(activityA.events).toContainEqual(expect.objectContaining({ invoice_id: fromA.id, discrepancy_id: priceFinding.id,
    approval_status: 'more_info_requested', reviewer_notes: notes }));
  expect(activityA.events).toContainEqual(expect.objectContaining({ purchase_order_id: poA.id, purchase_order_number: 'PO-2026-042' }));
  const activityB = (await env.call('GET', activityPath, { user: b })).body.data;
  expect(JSON.stringify(activityB)).not.toContain(fromA.id);
  expect(JSON.stringify(activityB)).not.toContain(poA.id);
  expect(JSON.stringify(activityB)).not.toContain(notes);
  const pathA = `/api/invoices/${fromA.id}`;
  expect((await env.call('GET', pathA, { user: b })).status).toBe(404);
  expect((await env.call('GET', pathA, { user: a })).body.data.document_url).toMatch(/^https:\/\//);
  expect(env.storage.objects.size).toBe(2);

  const [{ document_storage_path: foreignPath }] = await env.db.query('select document_storage_path from invoices where id = $1', [fromA.id]);
  await env.db.query('update invoices set document_storage_path = $1 where id = $2', [foreignPath, fromB.id]);
  expect((await env.call('GET', `/api/invoices/${fromB.id}`, { user: b })).body.data.document_url).toBeUndefined();

  const [{ organization_id }] = await env.db.query('select organization_id from invoices where id = $1', [fromA.id]);
  await env.db.query(`insert into audit_events (organization_id, actor_type, event_type, target_type, target_id)
    select $1, 'system', 'invoice.test_event', 'invoice', $2 from generate_series(1, 55)`, [organization_id, fromA.id]);
  const page = (await env.call('GET', activityPath, { user: a })).body.data;
  expect(page.events).toHaveLength(50);
  const olderPage = (await env.call('GET', `${activityPath}?before=${page.next_before}`, { user: a })).body.data;
  expect(olderPage.events).toContainEqual(expect.objectContaining({ reviewer_notes: notes }));
  expect(olderPage.events.every((event: { id: string }) => BigInt(event.id) < BigInt(page.next_before))).toBe(true);
});

it('takes a verified signup through upload, field review, matching, and audited discrepancy review', async () => {
  const user = randomUUID();
  const route = createRouter({ db: env.db, storage: env.storage, verifyToken: async () => null,
    verifyWorkspaceToken: async (token) => token === user ? user : null, log: () => {} });
  const provision = () => route({ method: 'POST', url: '/api/workspace', headers: { authorization: `Bearer ${user}` } });
  expect((await provision()).body).toEqual({ data: { role: 'reviewer' } });
  const [sample] = (await env.call('GET', '/api/invoices', { user })).body.data;
  const [po] = (await env.call('GET', '/api/purchase-orders', { user })).body.data;
  const uploaded = await env.call('POST', '/api/invoices', { user, body: invoiceBody({
    supplier_name: 'Northstar Paper Co.',
    invoice_number: 'CUSTOMER-TEST-01',
    po_reference: po.purchase_order_number,
    currency: null,
    subtotal: '650.00', tax_amount: '0.00', total_amount: '650.00',
    lines: [
      { sku: 'PAPER-A4', description: 'A4 copy paper, case', quantity: 12, unit_price: '44.00', line_total: '528.00', tax_amount: null },
      { sku: 'FOLDER-20', description: 'Project folders, pack of 20', quantity: 4, unit_price: '30.50', line_total: '122.00', tax_amount: null },
    ],
  }) });
  expect(uploaded.status).toBe(201);
  const path = `/api/invoices/${uploaded.body.data.id}`;
  const correction = await env.call('POST', `${path}/review-fields`, { user, body: {
    updated_at: uploaded.body.data.updated_at, values: { currency: 'USD' },
  } });
  expect(correction.status).toBe(200);
  expect(correction.body.data).toMatchObject({ purchase_order_id: po.id, currency: 'USD' });
  const findings = (await env.call('GET', `${path}/discrepancies`, { user })).body.data;
  expect(findings).toContainEqual(expect.objectContaining({ discrepancy_type: 'unit_price_mismatch', difference_amount: '48.00' }));
  const price = findings.find((finding: { difference_amount: string }) => finding.difference_amount === '48.00');
  const history = await env.call('GET', `/api/discrepancies/${price.id}/history`, { user });
  expect(history.status).toBe(200);
  expect(history.body.data.audit.length).toBeGreaterThan(0);

  expect((await provision()).status).toBe(200);
  const invoices = (await env.call('GET', '/api/invoices', { user })).body.data;
  expect(invoices.map((invoice: { id: string }) => invoice.id).sort()).toEqual([sample.id, uploaded.body.data.id].sort());
  expect((await env.call('GET', '/api/purchase-orders', { user })).body.data).toHaveLength(1);
});
