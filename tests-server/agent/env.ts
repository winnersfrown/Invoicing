// Agent test wiring: the real router, services, jobs and agent against PGlite, with a scripted or stubbed model.
import { randomUUID } from 'node:crypto';
import { investigateHandler, type Limits } from '../../server/agent/investigate';
import type { CompleteRequest, Completion, Model } from '../../server/agent/model';
import { createRouter, type HttpResponse } from '../../server/http/router';
import { registerJobHandler, runJobs } from '../../server/services/jobs';
import { memoryStorage } from '../../server/services/storage';
import { extracted, fileOf, pgliteDb, poBody } from '../api/helpers';
import { createTestDb } from '../db/harness';

/** Records every request the model receives (messages copied, since the loop keeps appending). */
export function spy(model: Model) {
  const requests: CompleteRequest[] = [];
  const wrapped: Model = { id: model.id, complete: (r) => { requests.push({ ...r, messages: [...r.messages] }); return model.complete(r); } };
  return { model: wrapped, requests };
}

/** A model that answers each call with the next step; the last step repeats. */
export function stub(id: string, steps: ((r: CompleteRequest, n: number) => Partial<Completion> | Promise<Partial<Completion>>)[]): Model {
  let n = 0;
  return {
    id,
    async complete(r) {
      const step = steps[Math.min(n, steps.length - 1)];
      const c = await step(r, n++);
      return { message: null, toolCalls: [], usage: { input_tokens: 100, output_tokens: 20 }, ...c };
    },
  };
}
export const call = (name: string, args: unknown, id = randomUUID()) => ({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });

export async function agentEnv(model: Model, limits: Partial<Limits> = {}) {
  const pg = (await createTestDb()).db;
  const db = pgliteDb(pg);
  const storage = memoryStorage();
  const router = createRouter({
    db, storage, verifyToken: async (t) => (t.startsWith('tok-') ? t.slice(4) : null),
    model: model.id, rateLimitPerMinute: 1000, log: () => {},
  });

  async function http(method: string, url: string, user?: string, body?: unknown): Promise<HttpResponse & { body: any }> {
    const headers: Record<string, string> = {};
    if (user) headers.authorization = `Bearer tok-${user}`;
    if (method !== 'GET') headers['idempotency-key'] = randomUUID();
    return router({ method, url, headers, body }) as never;
  }

  async function newOrg(name = 'Demo Org') {
    const [org] = await db.query<{ id: string }>('insert into organizations (name) values ($1) returning id', [name]);
    const users = { reviewer: randomUUID() };
    await db.query("insert into organization_memberships (user_id, organization_id, role) values ($1, $2, 'reviewer')", [users.reviewer, org.id]);
    return { id: org.id, ...users };
  }
  type Org = Awaited<ReturnType<typeof newOrg>>;

  /** The spec scenario: PO 12 × 40.00 = 480.00, invoice 12 × 45.00 = 540.00 from Example Office Supply. */
  async function scenario(org: Org, o: { invoice?: Record<string, unknown>; po?: Record<string, unknown> | null; beforeInvoice?: () => Promise<unknown> } = {}) {
    if (o.po !== null) {
      const po = await http('POST', '/api/purchase-orders', org.reviewer, poBody({ supplier_name: 'Example Office Supply', purchase_order_number: 'PO-1001', ...o.po,
        lines: [{ sku: 'PAPER-A4', description: 'A4 copy paper, box', quantity: 12, unit_price: '40.00', line_total: '480.00', tax_amount: null }] }));
      if (po.status !== 201) throw new Error(`PO setup failed: ${JSON.stringify(po.body)}`);
    }
    await o.beforeInvoice?.();
    const ex = extracted({
      supplier_name: 'Example Office Supply', invoice_number: `INV-${randomUUID().slice(0, 8)}`, po_reference: 'PO-1001',
      subtotal: '540.00', total_amount: '540.00', source_text: 'Example Office Supply invoice for A4 copy paper boxes delivered to head office',
      lines: [{ sku: 'PAPER-A4', description: 'A4 copy paper, box', quantity: 12, unit_price: '45.00', line_total: '540.00', tax_amount: null }],
      ...o.invoice,
    });
    const inv = await http('POST', '/api/invoices', org.reviewer, { file: fileOf(Buffer.from(JSON.stringify({ ...ex, nonce: randomUUID() }))), extracted: ex });
    if (inv.status !== 201) throw new Error(`Invoice setup failed: ${JSON.stringify(inv.body)}`);
    const disc = await http('GET', `/api/invoices/${inv.body.data.id}/discrepancies`, org.reviewer);
    return { invoiceId: inv.body.data.id as string, discrepancies: disc.body.data as { id: string; discrepancy_type: string; purchase_order_id: string | null }[] };
  }

  /** Runs due jobs with `m` as the investigate model. Its id must equal the router's (the env model's) id. */
  async function work(m: Model = model, l: Partial<Limits> = limits) {
    registerJobHandler('investigate', investigateHandler({ model: m, limits: l }));
    return runJobs(db);
  }

  /** POST investigate, run the worker, return the investigation DTO. */
  async function investigate(user: string, discrepancyId: string, m?: Model, l?: Partial<Limits>) {
    const r = await http('POST', `/api/discrepancies/${discrepancyId}/investigate`, user);
    if (r.status !== 202) throw new Error(`investigate failed: ${JSON.stringify(r.body)}`);
    await work(m, l);
    return (await http('GET', `/api/investigations/${r.body.data.id}`, user)).body.data;
  }

  /** Everything a financial decision touches, to prove the agent changed none of it. */
  async function snapshot(orgId: string) {
    const q = (sql: string) => db.query(sql, [orgId]);
    return JSON.stringify({
      invoices: await q('select id, status, total_amount::text, supplier_id, purchase_order_id from invoices where organization_id = $1 order by id'),
      lines: await q('select l.id, l.unit_price::text, l.quantity::text from invoice_line_items l join invoices i on i.id = l.invoice_id where i.organization_id = $1 order by l.id'),
      pos: await q('select id, status, total_amount::text from purchase_orders where organization_id = $1 order by id'),
      discrepancies: await q('select id, status from discrepancies where organization_id = $1 order by id'),
      resolutions: await q('select count(*)::int as n from resolution_actions where organization_id = $1'),
    });
  }

  return { pg, db, storage, router, http, newOrg, scenario, work, investigate, snapshot, close: () => pg.close() };
}
export type AgentEnv = Awaited<ReturnType<typeof agentEnv>>;
