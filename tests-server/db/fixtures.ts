// Test-only fixtures for the db suite: one row in every table for an organisation, and a
// per-table description (how to insert a fresh row, how to identify and modify the seeded one).
import { expect } from 'vitest';
import type { OrgSeed, TestDb } from './harness';

export interface Graph {
  org: OrgSeed;
  supplier: string; po: string; poLine: string; invoice: string; invoiceLine: string;
  discrepancy: string; investigation: string; resolution: string; draft: string; toolCall: string;
  audit: string; job: string; idemKey: string;
}

/** Seeds one row in every table for `org` through the privileged connection. */
export async function seedGraph(t: TestDb, org: OrgSeed): Promise<Graph> {
  return t.asService(async (tx) => {
    const one = async (sql: string, params: unknown[] = []) =>
      String((await tx.query<{ id: unknown }>(sql, params)).rows[0].id);
    const o = org.id;
    const u = org.reviewer;
    const supplier = await one(
      `insert into suppliers (organization_id, supplier_name, normalized_name, tax_identifier, contact_information)
       values ($1, 'Acme Ltd', 'acme ' || gen_random_uuid(), 'GB123', '{"email":"ap@acme.test"}') returning id`, [o]);
    const po = await one(
      `insert into purchase_orders (organization_id, supplier_id, purchase_order_number, currency, tax_amount, total_amount, status)
       values ($1, $2, 'PO-' || gen_random_uuid(), 'GBP', 10.00, 60.00, 'open') returning id`, [o, supplier]);
    const poLine = await one(
      `insert into purchase_order_line_items (purchase_order_id, line_number, sku, description, quantity, unit_price, line_total)
       values ($1, 1, 'SKU-1', 'Widget', 2, 25.00, 50.00) returning id`, [po]);
    const invoice = await one(
      `insert into invoices (organization_id, supplier_id, supplier_name_raw, invoice_number, po_reference, purchase_order_id,
         currency, subtotal, tax_amount, total_amount, status, document_storage_path, document_sha256, extraction, created_by)
       values ($1, $2, 'Acme Ltd', 'INV-1', 'PO-1', $3, 'GBP', 50.00, 10.00, 60.00, 'uploaded',
         'seed/path', repeat('a', 64), '{"method":"json"}', $4) returning id`, [o, supplier, po, u]);
    const invoiceLine = await one(
      `insert into invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total)
       values ($1, 1, 'Widget', 2, 25.00, 50.00) returning id`, [invoice]);
    const discrepancy = await one(
      `insert into discrepancies (organization_id, invoice_id, purchase_order_id, discrepancy_type, severity, status,
         deterministic_evidence, evidence_hash)
       values ($1, $2, $3, 'incorrect_total', 'high', 'open', '{}', 'h1') returning id`, [o, invoice, po]);
    const investigation = await one(
      `insert into ai_investigations (organization_id, discrepancy_id, model_identifier, prompt_version, investigation_status,
         evidence_hash, evidence_references, requested_by)
       values ($1, $2, 'model-x', 'investigate-v1', 'completed', 'h1', '[]', $3) returning id`, [o, discrepancy, u]);
    const resolution = await one(
      `insert into resolution_actions (organization_id, discrepancy_id, investigation_id, reviewer_id, approval_status, reviewer_notes)
       values ($1, $2, $3, $4, 'more_info_requested', 'n') returning id`, [o, discrepancy, investigation, u]);
    const draft = await one(
      `insert into supplier_message_drafts (organization_id, discrepancy_id, body, evidence_references, created_by)
       values ($1, $2, 'Dear supplier', '[]', $3) returning id`, [o, discrepancy, u]);
    const toolCall = await one(
      `insert into tool_calls (organization_id, investigation_id, tool_name, arguments, ok, duration_ms)
       values ($1, $2, 'get_invoice', '{}', true, 12) returning id`, [o, investigation]);
    const audit = await one(
      `insert into audit_events (organization_id, actor_type, actor_id, event_type, target_type, target_id)
       values ($1, 'user', $2, 'invoice.created', 'invoice', $3) returning id`, [o, u, invoice]);
    const job = await one(
      `insert into jobs (organization_id, kind, payload, idempotency_key) values ($1, 'process_invoice', '{}', gen_random_uuid()::text)
       returning id`, [o]);
    const idemKey = await one(
      `insert into idempotency_keys (organization_id, key, endpoint, user_id, response, status_code)
       values ($1, gen_random_uuid()::text, 'POST /api/invoices', $2, '{}', 201) returning key as id`, [o, u]);
    return { org, supplier, po, poLine, invoice, invoiceLine, discrepancy, investigation, resolution, draft, toolCall, audit, job, idemKey };
  });
}

export interface TableSpec {
  table: string;
  /** WHERE clause selecting the seeded row of graph g. */
  key: (g: Graph) => string;
  /** INSERT of a brand-new row belonging to g's organisation; succeeds for g's reviewer. */
  insert: (g: Graph) => string;
  /** SET clause that changes the seeded row. */
  set: string;
  appendOnly?: boolean;
  /** Deletable by reviewers/admins of the owning org (FK restrict still applies). Only suppliers and memberships. */
  deletable?: boolean;
}

const rnd = `(1000 + floor(random() * 1e9))::int`;

/** Every table carrying organisation data, except organizations and organization_memberships. */
export const ORG_TABLES: TableSpec[] = [
  { table: 'suppliers', key: (g) => `id = '${g.supplier}'`, set: `supplier_name = 'changed'`, deletable: true,
    insert: (g) => `insert into suppliers (organization_id, supplier_name, normalized_name)
      values ('${g.org.id}', 'New', gen_random_uuid()::text)` },
  { table: 'invoices', key: (g) => `id = '${g.invoice}'`, set: `status = 'rejected'`,
    insert: (g) => `insert into invoices (organization_id, status, document_storage_path, document_sha256, extraction, created_by)
      values ('${g.org.id}', 'uploaded', 'p', repeat('b', 64), '{}', '${g.org.reviewer}')` },
  { table: 'invoice_line_items', key: (g) => `id = '${g.invoiceLine}'`, set: `description = 'changed'`,
    insert: (g) => `insert into invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total)
      values ('${g.invoice}', ${rnd}, 'd', 1, 1.00, 1.00)` },
  { table: 'purchase_orders', key: (g) => `id = '${g.po}'`, set: `status = 'closed'`,
    insert: (g) => `insert into purchase_orders (organization_id, supplier_id, purchase_order_number, currency, tax_amount, total_amount, status)
      values ('${g.org.id}', '${g.supplier}', gen_random_uuid()::text, 'GBP', 0, 0, 'open')` },
  { table: 'purchase_order_line_items', key: (g) => `id = '${g.poLine}'`, set: `description = 'changed'`,
    insert: (g) => `insert into purchase_order_line_items (purchase_order_id, line_number, description, quantity, unit_price, line_total)
      values ('${g.po}', ${rnd}, 'd', 1, 1.00, 1.00)` },
  { table: 'discrepancies', key: (g) => `id = '${g.discrepancy}'`, set: `status = 'dismissed'`,
    insert: (g) => `insert into discrepancies (organization_id, invoice_id, discrepancy_type, severity, status, deterministic_evidence, evidence_hash)
      values ('${g.org.id}', '${g.invoice}', 'tax_mismatch', 'low', 'open', '{}', gen_random_uuid()::text)` },
  { table: 'ai_investigations', key: (g) => `id = '${g.investigation}'`, set: `error = 'changed'`,
    insert: (g) => `insert into ai_investigations (organization_id, discrepancy_id, model_identifier, prompt_version,
        investigation_status, evidence_hash, evidence_references, requested_by)
      values ('${g.org.id}', '${g.discrepancy}', 'm', 'investigate-v1', 'queued', gen_random_uuid()::text, '[]', '${g.org.reviewer}')` },
  { table: 'resolution_actions', key: (g) => `id = '${g.resolution}'`, set: `reviewer_notes = 'tampered'`, appendOnly: true,
    insert: (g) => `insert into resolution_actions (organization_id, discrepancy_id, reviewer_id, approval_status, reviewer_notes)
      values ('${g.org.id}', '${g.discrepancy}', '${g.org.reviewer}', 'rejected', '')` },
  { table: 'supplier_message_drafts', key: (g) => `id = '${g.draft}'`, set: `body = 'tampered'`, appendOnly: true,
    insert: (g) => `insert into supplier_message_drafts (organization_id, discrepancy_id, body, evidence_references, created_by)
      values ('${g.org.id}', '${g.discrepancy}', 'b', '[]', '${g.org.reviewer}')` },
  { table: 'tool_calls', key: (g) => `id = '${g.toolCall}'`, set: `ok = false`, appendOnly: true,
    insert: (g) => `insert into tool_calls (organization_id, investigation_id, tool_name, arguments, ok, duration_ms)
      values ('${g.org.id}', '${g.investigation}', 'get_supplier', '{}', true, 1)` },
  { table: 'audit_events', key: (g) => `id = ${g.audit}`, set: `event_type = 'tampered'`, appendOnly: true,
    insert: (g) => `insert into audit_events (organization_id, actor_type, actor_id, event_type, target_type, target_id)
      values ('${g.org.id}', 'user', '${g.org.reviewer}', 'x', 'invoice', '${g.invoice}')` },
];

export const MEMBERSHIPS: TableSpec = {
  table: 'organization_memberships', key: (g) => `organization_id = '${g.org.id}' and user_id = '${g.org.viewer}'`,
  set: `role = 'admin'`, deletable: true,
  insert: (g) => `insert into organization_memberships (user_id, organization_id, role) values (gen_random_uuid(), '${g.org.id}', 'viewer')`,
};
export const ORGANIZATIONS: TableSpec = {
  table: 'organizations', key: (g) => `id = '${g.org.id}'`, set: `name = 'renamed'`,
  insert: () => `insert into organizations (name) values ('new org')`,
};
export const PRIVILEGED_ONLY = ['jobs', 'idempotency_keys'];
export const ALL_TABLES = [ORGANIZATIONS.table, MEMBERSHIPS.table, ...ORG_TABLES.map((s) => s.table), ...PRIVILEGED_ONLY];

/** Snapshot of a row as seen by the privileged connection (null if it no longer exists). */
export async function snapshot(t: TestDb, spec: TableSpec, g: Graph): Promise<unknown> {
  const r = await t.asService((tx) => tx.query<{ j: unknown }>(`select to_jsonb(x) as j from ${spec.table} x where ${spec.key(g)}`));
  return r.rows[0]?.j ?? null;
}

const isDenial = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  return err.code === '42501' || /append-only/.test(err.message ?? '');
};

/**
 * Runs a write as `userId` and returns the number of rows it changed. A permission/RLS/append-only
 * error counts as 0 rows; any other error (syntax, constraint) is rethrown so a broken test cannot pass.
 */
export async function rowsChanged(t: TestDb, userId: string, sql: string): Promise<number> {
  try {
    return (await t.asUser(userId, (tx) => tx.query(sql))).affectedRows ?? 0;
  } catch (e) {
    if (isDenial(e)) return 0;
    throw e;
  }
}

/** Asserts the write is refused outright by a privilege or row-level-security check. */
export async function expectDenied(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: '42501' });
}
