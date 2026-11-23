// Data access: the Db interface, the pg implementation, the per-request user scope, and the only place
// where numeric(14,2) strings become integer cents (and back).
import pg from 'pg';
import { centsToMoney, moneyToCents, type InvoiceStatus } from '../contracts/index.ts';
import type { z } from 'zod';

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn in one transaction; inside a transaction it simply runs fn on the same connection. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Production Db: node-postgres against DATABASE_URL (the Supabase pooler, privileged connection). */
export function pgDb(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString, max: 3 });
  const on = (c: pg.Pool | pg.PoolClient) => async (sql: string, params?: unknown[]) => (await c.query(sql, params as unknown[])).rows;
  return {
    query: on(pool) as Db['query'],
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Db = { query: on(client) as Db['query'], transaction: (f) => f(tx) };
      try {
        await client.query('begin');
        const result = await fn(tx);
        await client.query('commit');
        return result;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Runs fn with row-level security applied for userId, inside an already-open transaction `tx`
 * (SCHEMA.md connection model). The role is reset afterwards so the caller can finish privileged work
 * (idempotency record, job enqueue) in the same transaction. On error the transaction rolls back anyway.
 */
export async function asUser<T>(tx: Db, userId: string, fn: () => Promise<T>): Promise<T> {
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  await tx.query('set local role authenticated');
  const result = await fn();
  await tx.query('reset role');
  return result;
}

// ---------- money and quantity boundary ----------
export const toCents = (v: string | null | undefined): number | null => (v == null ? null : moneyToCents(String(v)));
export const toMoney = (c: number | null | undefined): string | null => (c == null ? null : centsToMoney(c));
/** numeric(14,3) quantity string -> integer thousandths. */
export const toMilli = (v: string | number): number => {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(v));
  if (!m) throw new Error('Invalid quantity');
  return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
};
export const milliToString = (q: number) => `${Math.floor(q / 1000)}.${String(q % 1000).padStart(3, '0')}`;
export const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
export const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

// ---------- rows ----------
export type Line = {
  id: string; line_number: number; sku: string | null; description: string;
  qty_milli: number; unit_price: number; line_total: number; tax_amount: number | null;
};
export type Invoice = {
  id: string; organization_id: string; supplier_id: string | null; supplier_name_raw: string | null;
  invoice_number: string | null; invoice_date: string | null; due_date: string | null; po_reference: string | null;
  purchase_order_id: string | null; currency: string | null;
  subtotal: number | null; tax_amount: number | null; total_amount: number | null;
  status: z.infer<typeof InvoiceStatus>; document_storage_path: string; document_sha256: string; source_text: string | null;
  extraction_confidence: number | null; extraction: any; supersedes_invoice_id: string | null;
  archived_at: string | null; archived_by: string | null;
  created_by: string; created_at: string; updated_at: string; lines: Line[];
};
export type PurchaseOrder = {
  id: string; organization_id: string; supplier_id: string; supplier_name: string; purchase_order_number: string;
  currency: string; tax_amount: number; total_amount: number; status: string; created_at: string; lines: Line[];
};

export const INVOICE_COLUMNS = `i.id, i.organization_id, i.supplier_id, i.supplier_name_raw, i.invoice_number, i.invoice_date::text as invoice_date,
  i.due_date::text as due_date, i.po_reference, i.purchase_order_id, i.currency, i.subtotal::text as subtotal, i.tax_amount::text as tax_amount,
  i.total_amount::text as total_amount, i.status, i.document_storage_path, i.document_sha256, i.source_text,
  i.extraction_confidence::text as extraction_confidence, i.extraction, i.supersedes_invoice_id, i.archived_at, i.archived_by, i.created_by, i.created_at, i.updated_at`;

const lineFromRow = (r: any): Line => ({
  id: r.id, line_number: r.line_number, sku: r.sku, description: r.description, qty_milli: toMilli(r.quantity),
  unit_price: toCents(r.unit_price)!, line_total: toCents(r.line_total)!, tax_amount: toCents(r.tax_amount ?? null),
});
export const invoiceFromRow = (r: any, lines: Line[] = []): Invoice => ({
  ...r, subtotal: toCents(r.subtotal), tax_amount: toCents(r.tax_amount), total_amount: toCents(r.total_amount),
  extraction_confidence: r.extraction_confidence == null ? null : Number(r.extraction_confidence),
  archived_at: isoOrNull(r.archived_at),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), lines,
});

const LINE_COLUMNS = `id, line_number, sku, description, quantity::text as quantity, unit_price::text as unit_price, line_total::text as line_total`;

/** Invoice with lines, or null when it does not exist in orgId. `lock` takes a row lock for a state change. */
export async function loadInvoice(db: Db, orgId: string, id: string, lock = false): Promise<Invoice | null> {
  const [row] = await db.query(`select ${INVOICE_COLUMNS} from invoices i where i.id = $1 and i.organization_id = $2${lock ? ' for update' : ''}`, [id, orgId]);
  if (!row) return null;
  const lines = await db.query(`select ${LINE_COLUMNS}, tax_amount::text as tax_amount from invoice_line_items where invoice_id = $1 order by line_number`, [id]);
  return invoiceFromRow(row, lines.map(lineFromRow));
}

export async function loadPurchaseOrder(db: Db, orgId: string, id: string): Promise<PurchaseOrder | null> {
  const [row] = await db.query(
    `select p.id, p.organization_id, p.supplier_id, s.supplier_name, p.purchase_order_number, p.currency, p.tax_amount::text as tax_amount,
       p.total_amount::text as total_amount, p.status, p.created_at
     from purchase_orders p join suppliers s on s.id = p.supplier_id where p.id = $1 and p.organization_id = $2`, [id, orgId]);
  if (!row) return null;
  const lines = await db.query(`select ${LINE_COLUMNS}, null as tax_amount from purchase_order_line_items where purchase_order_id = $1 order by line_number`, [id]);
  return { ...row, tax_amount: toCents(row.tax_amount)!, total_amount: toCents(row.total_amount)!, created_at: iso(row.created_at), lines: lines.map(lineFromRow) } as PurchaseOrder;
}
