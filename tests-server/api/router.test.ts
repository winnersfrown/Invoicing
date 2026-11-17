import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvestigationDto, ROUTES, SupplierMessageDraftDto } from '../../server/contracts/index';
import { createRouter } from '../../server/http/router';
import { memoryStorage } from '../../server/services/storage';
import { fileOf, invoiceBody, poBody, setup, type Env } from './helpers';

let env: Env;
type Org = Awaited<ReturnType<Env['newOrg']>>;
let a: Org, b: Org;
let ids: { invoice: string; discrepancy: string; investigation: string };

beforeAll(async () => {
  env = await setup();
  [a, b] = [await env.newOrg(), await env.newOrg()];
  for (const org of [a, b]) await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody() });
  const inv = await env.call('POST', '/api/invoices', { user: a.reviewer, body: invoiceBody() });
  const disc = await env.call('GET', `/api/invoices/${inv.body.data.id}/discrepancies`, { user: a.viewer });
  const investigation = await env.call('POST', `/api/discrepancies/${disc.body.data[0].id}/investigate`, { user: a.reviewer });
  ids = { invoice: inv.body.data.id, discrepancy: disc.body.data[0].id, investigation: investigation.body.data.id };
});
afterAll(async () => env.close());

const userRoutes = Object.entries(ROUTES).filter(([, role]) => role !== 'system' && role !== 'public').map(([k]) => k);
const urlFor = (route: string) => {
  const [method, path] = route.split(' ');
  const id = path.startsWith('/api/investigations') ? ids.investigation : path.startsWith('/api/discrepancies') ? ids.discrepancy : ids.invoice;
  return { method, url: path.replace(':id', id) };
};
const validBody = (route: string): unknown => ({
  'POST /api/invoices': invoiceBody({ invoice_number: `X-${randomUUID()}` }),
  'POST /api/purchase-orders': poBody({ purchase_order_number: `PO-${randomUUID()}` }),
  'POST /api/discrepancies/:id/resolve': { decision: 'more_info_requested', notes: 'x' },
  'POST /api/discrepancies/:id/draft-message': {},
}[route] ?? {});

describe('authentication and roles', () => {
  it.each(userRoutes)('%s without a token is unauthenticated', async (route) => {
    const { method, url } = urlFor(route);
    const r = await env.call(method, url, { body: validBody(route) });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: 'unauthenticated', message: expect.any(String) } });
  });

  it('a bad token and a user without membership are refused', async () => {
    expect((await env.call('GET', '/api/invoices', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await env.call('GET', '/api/invoices', { user: randomUUID() })).status).toBe(403);
  });

  it.each(userRoutes.filter((r) => r.startsWith('POST')))('viewer cannot call %s', async (route) => {
    const { method, url } = urlFor(route);
    const r = await env.call(method, url, { user: a.viewer, body: validBody(route) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
  });

  it.each(userRoutes.filter((r) => r.includes(':id')))('%s on another organisation\'s row is not_found', async (route) => {
    const { method, url } = urlFor(route);
    const r = await env.call(method, url, { user: b.admin, body: validBody(route) });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
    const missing = await env.call(method, url.replace(/[0-9a-f-]{36}/, randomUUID()), { user: b.admin, body: validBody(route) });
    expect(missing.body).toEqual(r.body); // indistinguishable from a missing row
  });

  it('lists never include another organisation\'s rows, and foreign ids in bodies are not_found', async () => {
    const invoices = await env.call('GET', '/api/invoices', { user: b.viewer });
    expect(invoices.body.data.map((i: { id: string }) => i.id)).not.toContain(ids.invoice);
    const pos = await env.call('GET', '/api/purchase-orders', { user: b.viewer });
    expect(pos.body.data).toHaveLength(1);
    const supersede = await env.call('POST', '/api/invoices', { user: b.reviewer, body: invoiceBody({ invoice_number: 'B-1' }, { supersedes_invoice_id: ids.invoice }) });
    expect(supersede.status).toBe(404);
    const foreignInvestigation = await env.call('POST', `/api/discrepancies/${ids.discrepancy}/resolve`,
      { user: a.reviewer, body: { decision: 'rejected', investigation_id: randomUUID() } });
    expect(foreignInvestigation.status).toBe(404);
  });

  it('malformed ids and unknown routes are not_found', async () => {
    expect((await env.call('GET', '/api/invoices/not-a-uuid', { user: a.viewer })).status).toBe(404);
    expect((await env.call('GET', '/api/nothing', { user: a.viewer })).status).toBe(404);
    expect((await env.call('DELETE', `/api/invoices/${ids.invoice}`, { user: a.admin })).status).toBe(404);
  });
});

describe('request validation', () => {
  it.each([
    ['POST /api/invoices', { file: {} }],
    ['POST /api/purchase-orders', poBody({ lines: [] })],
    ['POST /api/discrepancies/:id/resolve', { decision: 'approved' }],
    ['POST /api/discrepancies/:id/draft-message', { requested_correction: '' }],
  ])('%s rejects an invalid body', async (route, body) => {
    const { method, url } = urlFor(route);
    const r = await env.call(method, url, { user: a.reviewer, body });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_request');
  });

  it('mutations require a valid Idempotency-Key', async () => {
    expect((await env.call('POST', '/api/purchase-orders', { user: a.reviewer, body: poBody(), key: null })).status).toBe(400);
    expect((await env.call('POST', '/api/purchase-orders', { user: a.reviewer, body: poBody(), key: 'bad key!' })).status).toBe(400);
  });

  it.each([
    ['hash mismatch', (f: any) => ({ ...f, sha256: 'a'.repeat(64) })],
    ['size mismatch', (f: any) => ({ ...f, size_bytes: f.size_bytes + 1 })],
    ['declared PDF but JSON bytes', (f: any) => ({ ...f, mime_type: 'application/pdf' })],
    ['invalid base64', (f: any) => ({ ...f, content_base64: '@@@@' })],
  ])('upload rejected: %s', async (_name, mutate) => {
    const body = invoiceBody({ invoice_number: 'U-1' });
    const r = await env.call('POST', '/api/invoices', { user: a.reviewer, body: { ...body, file: mutate(body.file) } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_request');
  });

  it('accepts a real PDF signature and stores the document privately', async () => {
    const pdf = Buffer.from('%PDF-1.7\n%test document\n');
    const body = { ...invoiceBody({ invoice_number: 'PDF-1', subtotal: '480.00', total_amount: '480.00',
      lines: [{ sku: 'WID-1', description: 'Widget', quantity: 12, unit_price: '40.00', line_total: '480.00', tax_amount: null }] }), file: fileOf(pdf, 'application/pdf', 'i.pdf') };
    const r = await env.call('POST', '/api/invoices', { user: a.reviewer, body });
    expect(r.status).toBe(201);
    const path = `${a.id}/${r.body.data.id}/${body.file.sha256}`;
    expect(env.storage.objects.get(path)?.bytes).toEqual(new Uint8Array(pdf));
  });
});

describe('resolution, idempotency and concurrency', () => {
  async function freshDiscrepancy(org: Org) {
    const inv = await env.call('POST', '/api/invoices', { user: org.reviewer, body: invoiceBody({ invoice_number: `R-${randomUUID()}`, source_text: randomUUID() }) });
    const ds = await env.call('GET', `/api/invoices/${inv.body.data.id}/discrepancies`, { user: org.viewer });
    return { invoiceId: inv.body.data.id as string, id: ds.body.data.find((d: any) => d.discrepancy_type === 'unit_price_mismatch').id as string };
  }
  const approve = { decision: 'approved', approved_action: 'approve_review_completion', notes: 'Price change confirmed with buyer' };

  it('same key replays the first response and writes one row; a different key conflicts', async () => {
    const d = await freshDiscrepancy(a);
    const first = await env.call('POST', `/api/discrepancies/${d.id}/resolve`, { user: a.reviewer, body: approve, key: 'resolve-key-1' });
    expect(first.status).toBe(200);
    expect(first.body.data.discrepancy.status).toBe('resolved');
    expect(first.body.data.invoice_status).toBe('resolved');
    const replay = await env.call('POST', `/api/discrepancies/${d.id}/resolve`, { user: a.reviewer, body: approve, key: 'resolve-key-1' });
    expect(replay).toEqual(first);
    const other = await env.call('POST', `/api/discrepancies/${d.id}/resolve`, { user: a.reviewer, body: approve, key: 'resolve-key-2' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('conflict');
    const rows = await env.db.query('select * from resolution_actions where discrepancy_id = $1', [d.id]);
    expect(rows).toHaveLength(1);
    const reused = await env.call('POST', `/api/discrepancies/${d.id}/resolve`, { user: a.reviewer, body: { ...approve, notes: 'other' }, key: 'resolve-key-1' });
    expect(reused.status).toBe(409);
  });

  it('two concurrent approvals: exactly one succeeds', async () => {
    const d = await freshDiscrepancy(a);
    const results = await Promise.all([a.reviewer, a.admin].map((user) =>
      env.call('POST', `/api/discrepancies/${d.id}/resolve`, { user, body: approve })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await env.db.query('select * from resolution_actions where discrepancy_id = $1', [d.id])).toHaveLength(1);
  });

  it('approval records the human decision without touching invoice or PO values', async () => {
    const d = await freshDiscrepancy(a);
    const [before] = await env.db.query('select subtotal, tax_amount, total_amount, purchase_order_id from invoices where id = $1', [d.invoiceId]);
    const r = await env.call('POST', `/api/discrepancies/${d.id}/resolve`, { user: a.reviewer,
      body: { decision: 'approved', approved_action: 'request_corrected_invoice', notes: 'Ask supplier' } });
    expect(r.body.data.discrepancy.status).toBe('awaiting_supplier');
    expect(r.body.data.invoice_status).toBe('exception');
    const [after] = await env.db.query('select subtotal, tax_amount, total_amount, purchase_order_id from invoices where id = $1', [d.invoiceId]);
    expect(after).toEqual(before);
    const history = await env.call('GET', `/api/discrepancies/${d.id}/history`, { user: a.viewer });
    expect(history.body.data.resolutions).toHaveLength(1);
    expect(history.body.data.audit.map((e: any) => e.event_type)).toEqual(
      ['discrepancy.created', 'resolution.recorded', 'discrepancy.status_changed']);
  });

  it('rate limit is enforced per user from Postgres', async () => {
    const limited = await setup({ rateLimitPerMinute: 2 });
    try {
      const org = await limited.newOrg();
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await limited.call('POST', '/api/purchase-orders',
        { user: org.reviewer, body: poBody({ purchase_order_number: `PO-${i}` }) })).status);
      expect(statuses).toEqual([201, 201, 429]);
      const other = await limited.call('POST', '/api/purchase-orders', { user: org.admin, body: poBody({ purchase_order_number: 'PO-x' }) });
      expect(other.status).toBe(201);
    } finally { await limited.close(); }
  });
});

describe('investigation, drafts and the worker endpoint', () => {
  it('investigate queues once per evidence hash and returns the existing row', async () => {
    const again = await env.call('POST', `/api/discrepancies/${ids.discrepancy}/investigate`, { user: a.reviewer });
    expect(again.status).toBe(202);
    expect(again.body.data.id).toBe(ids.investigation);
    const dto = InvestigationDto.parse(again.body.data);
    expect(dto).toMatchObject({ investigation_status: 'queued', model_identifier: 'test-model', prompt_version: 'investigate-v1', result: null });
    const jobs = await env.db.query<{ payload: any }>(`select payload from jobs where kind = 'investigate' and organization_id = $1`, [a.id]);
    expect(jobs).toEqual([{ payload: { investigation_id: ids.investigation, discrepancy_id: ids.discrepancy } }]);
    const got = await env.call('GET', `/api/investigations/${ids.investigation}`, { user: a.viewer });
    expect(got.body.data.id).toBe(ids.investigation);
  });

  it('draft-message stores an unsent draft built by the engine', async () => {
    const r = await env.call('POST', `/api/discrepancies/${ids.discrepancy}/draft-message`, { user: a.reviewer, body: { requested_correction: 'Reissue at the PO price' } });
    expect(r.status).toBe(201);
    const draft = SupplierMessageDraftDto.parse(r.body.data);
    expect(draft.sent).toBe(false);
    expect(draft.body).toMatch(/12 × \$45\.00/);
    expect(draft.body).toMatch(/12 × \$40\.00/);
    expect(draft.body).toMatch(/Reissue at the PO price/);
    expect(draft.evidence_references).toContain(`discrepancy:${ids.discrepancy}`);
  });

  it('POST /api/jobs/run needs the cron secret', async () => {
    expect((await env.call('POST', '/api/jobs/run', { key: null })).status).toBe(401);
    expect((await env.call('POST', '/api/jobs/run', { key: null, headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await env.call('POST', '/api/jobs/run', { key: null, user: a.admin })).status).toBe(401);
    const ok = await env.call('POST', '/api/jobs/run', { key: null, headers: { authorization: 'Bearer cron-secret-for-tests' } });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.data.results)).toBe(true);
  });

  it('an unexpected database error is a generic 500 with no SQL or stack', async () => {
    const boom = Object.assign(new Error('relation "invoices" does not exist: select * from invoices where organization_id = $1'), { code: '42P01' });
    const logs: Record<string, unknown>[] = [];
    const broken = createRouter({ db: { query: async () => { throw boom; }, transaction: async () => { throw boom; } },
      storage: memoryStorage(), verifyToken: async () => a.reviewer, log: (e) => logs.push(e) });
    const r = await broken({ method: 'GET', url: '/api/invoices', headers: { authorization: 'Bearer x' } });
    expect(r).toEqual({ status: 500, body: { error: { code: 'internal', message: 'Internal error' } } });
    expect(JSON.stringify(logs)).not.toMatch(/select|relation/);
    expect(logs[0]).toMatchObject({ level: 'error', pg_code: '42P01' });
  });

  it('logs are structured and never carry tokens or document contents', () => {
    expect(env.logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(env.logs);
    expect(text).not.toMatch(/tok-|cron-secret|Northwind Supplies delivery|base64/);
    expect(env.logs[0]).toMatchObject({ route: expect.any(String), status: expect.any(Number), duration_ms: expect.any(Number) });
  });
});
