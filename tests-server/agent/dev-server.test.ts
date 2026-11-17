import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigDto } from '../../server/contracts/index';
import { startDevServer } from '../../scripts/dev-server';

describe('dev server', () => {
  let server: Awaited<ReturnType<typeof startDevServer>>;
  beforeAll(async () => { server = await startDevServer({ port: 0, env: {}, log: () => {} }); });
  afterAll(async () => server?.close());

  const get = (path: string, token?: string) => fetch(server.url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const post = (path: string, token: string, body: unknown = {}) => fetch(server.url + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('refuses to start in production', async () => {
    await expect(startDevServer({ port: 0, env: { VERCEL: '1' } })).rejects.toThrow(/production/i);
    await expect(startDevServer({ port: 0, env: { NODE_ENV: 'production' } })).rejects.toThrow(/production/i);
  });

  it('GET /api/config returns the three dev users', async () => {
    const res = await get('/api/config');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const config = ConfigDto.parse(data);
    expect(config.mode).toBe('dev');
    if (config.mode === 'dev') expect(config.dev_users.map((u) => u.role).sort()).toEqual(['admin', 'reviewer', 'viewer']);
  });

  it('serves dist/ and refuses paths outside it', async () => {
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    expect((await get('/engine.js')).headers.get('content-type')).toMatch(/javascript/);
    expect((await get('/..%2fpackage.json')).status).toBe(404);
    expect((await get('/nothing-here.js')).status).toBe(404);
  });

  it('the seeded spec scenario can be investigated over HTTP with the scripted model', async () => {
    const { data } = await (await get('/api/config')).json();
    const token = (role: string) => data.dev_users.find((u: { role: string }) => u.role === role).token;
    expect((await get('/api/invoices')).status).toBe(401);
    const invoices = (await (await get('/api/invoices', token('viewer'))).json()).data;
    const inv = invoices.find((i: { supplier_name: string; status: string }) => i.supplier_name === 'Example Office Supply' && i.status === 'exception');
    expect(inv).toMatchObject({ total_amount: '540.00', open_discrepancy_count: 1 });
    const [d] = (await (await get(`/api/invoices/${inv.id}/discrepancies`, token('viewer'))).json()).data;
    expect((await post(`/api/discrepancies/${d.id}/investigate`, token('viewer'))).status).toBe(403);
    const started = await post(`/api/discrepancies/${d.id}/investigate`, token('reviewer'));
    expect(started.status).toBe(202);
    const id = (await started.json()).data.id;
    let dto: any;
    for (let i = 0; i < 100; i++) {
      dto = (await (await get(`/api/investigations/${id}`, token('viewer'))).json()).data;
      if (!['queued', 'in_progress'].includes(dto.investigation_status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(dto).toMatchObject({ investigation_status: 'completed', model_identifier: 'scripted-investigator' });
    expect(dto.result).toMatchObject({ recommended_action: 'request_corrected_invoice', requires_human_approval: true,
      verified_financial_impact: { currency: 'USD', amount: '60.00', source: 'deterministic_engine' } });
  });
});

it('defaults to scripted mode even when an API key is present',async()=>{
 const s=await startDevServer({port:0,env:{OPENAI_API_KEY:'test-placeholder-never-call'},log:()=>{}});
 try{expect(s.model).toBe('scripted-investigator');}finally{await s.close();}
});
