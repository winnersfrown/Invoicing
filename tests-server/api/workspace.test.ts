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
  const pathA = `/api/invoices/${fromA.id}`;
  expect((await env.call('GET', pathA, { user: b })).status).toBe(404);
  expect((await env.call('GET', pathA, { user: a })).body.data.document_url).toMatch(/^https:\/\//);
  expect(env.storage.objects.size).toBe(2);

  const [{ document_storage_path: foreignPath }] = await env.db.query('select document_storage_path from invoices where id = $1', [fromA.id]);
  await env.db.query('update invoices set document_storage_path = $1 where id = $2', [foreignPath, fromB.id]);
  expect((await env.call('GET', `/api/invoices/${fromB.id}`, { user: b })).body.data.document_url).toBeUndefined();
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
