// Test wiring: the real router and services against PGlite, a fake token verifier and in-memory storage.
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';
import { createTestDb } from '../db/harness';
import type { Db } from '../../server/db/index';
import { createRouter, type HttpResponse } from '../../server/http/router';
import { memoryStorage } from '../../server/services/storage';

/** PGlite as the server's Db interface (the test implementation). */
export function pgliteDb(pg: PGlite | Transaction): Db {
  const self: Db = {
    query: async (sql, params) => (await pg.query(sql, params as unknown[])).rows as never,
    transaction: (fn) => ('transaction' in pg ? pg.transaction((tx) => fn(pgliteDb(tx))) : fn(self)),
  };
  return self;
}

export const T0 = new Date('2026-11-15T12:00:00Z');

export async function setup(opts: { rateLimitPerMinute?: number } = {}) {
  const pg = (await createTestDb()).db;
  const db = pgliteDb(pg);
  const storage = memoryStorage();
  const logs: Record<string, unknown>[] = [];
  const clock = { now: T0 };
  const router = createRouter({
    db, storage,
    verifyToken: async (token) => (token.startsWith('tok-') ? token.slice(4) : null),
    now: () => clock.now,
    cronSecret: 'cron-secret-for-tests',
    model: 'test-model',
    rateLimitPerMinute: opts.rateLimitPerMinute ?? 1000,
    log: (e) => logs.push(e),
  });

  async function newOrg() {
    const [org] = await db.query<{ id: string }>(`insert into organizations (name) values ('Org') returning id`);
    const users = { reviewer: randomUUID(), secondReviewer: randomUUID() };
    for (const id of Object.values(users)) {
      await db.query("insert into organization_memberships (user_id, organization_id, role) values ($1, $2, 'reviewer')", [id, org.id]);
    }
    return { id: org.id, ...users };
  }

  type CallOpts = { user?: string; body?: unknown; key?: string | null; headers?: Record<string, string> };
  async function call(method: string, url: string, o: CallOpts = {}): Promise<HttpResponse & { body: any }> {
    const headers: Record<string, string> = { ...o.headers };
    if (o.user) headers.authorization = `Bearer tok-${o.user}`;
    const key = o.key === undefined ? (method === 'GET' ? null : randomUUID()) : o.key;
    if (key) headers['idempotency-key'] = key;
    return router({ method, url, headers, body: o.body }) as never;
  }

  return { pg, db, storage, router, logs, clock, newOrg, call, close: () => pg.close() };
}
export type Env = Awaited<ReturnType<typeof setup>>;

// ---------- fixtures ----------
export const SOURCE =
  'Northwind Supplies delivery covers widget assemblies sealed components inspection labels protective packaging scheduled transport regional depot payment thirty days';

export function poBody(over: Record<string, unknown> = {}) {
  return {
    supplier_name: 'Northwind Supplies LLC', purchase_order_number: 'PO-1001', currency: 'USD',
    tax_amount: '0.00', total_amount: '480.00',
    lines: [{ sku: 'WID-1', description: 'Widget', quantity: 12, unit_price: '40.00', line_total: '480.00', tax_amount: null }],
    ...over,
  };
}

export function extracted(over: Record<string, unknown> = {}) {
  return {
    supplier_name: 'Northwind Supplies LLC', invoice_number: 'INV-2001', invoice_date: '2026-11-01', due_date: '2026-12-01',
    po_reference: 'PO-1001', currency: 'USD', subtotal: '540.00', tax_amount: '0.00', total_amount: '540.00',
    lines: [{ sku: 'WID-1', description: 'Widget', quantity: 12, unit_price: '45.00', line_total: '540.00', tax_amount: null }],
    source_text: SOURCE,
    extraction: { method: 'json', confidence: 0.98, field_confidence: {}, missing: [], uncertain: [], source_refs: {} },
    ...over,
  };
}

export function fileOf(bytes: Buffer, mime = 'application/json', name = 'invoice.json') {
  return { name, mime_type: mime, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') };
}

/** Request body for POST /api/invoices. The file is the extracted JSON itself, so each invoice has its own hash. */
export function invoiceBody(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const ex = extracted(over);
  return { file: fileOf(Buffer.from(JSON.stringify(ex))), extracted: ex, ...extra };
}
