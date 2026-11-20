import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRouter } from '../../server/http/router';
import { setup, type Env } from './helpers';

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
