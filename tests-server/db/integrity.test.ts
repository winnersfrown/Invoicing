// Data integrity: exact money, uniqueness rules from SCHEMA.md, enum checks matching server/contracts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActorType, ApprovalStatus, Confidence, DiscrepancyStatus, DiscrepancyType, InvestigationStatus, InvoiceStatus, JobStatus,
  RecommendedAction, Role, Severity,
} from '../../server/contracts/index';
import { createTestDb, seedTwoOrgs, type TestDb, type TwoOrgs } from './harness';
import { seedGraph, type Graph } from './fixtures';

let t: TestDb;
let s: TwoOrgs;
let a: Graph;
let b: Graph;

beforeAll(async () => {
  t = await createTestDb();
  s = await seedTwoOrgs(t);
  a = await seedGraph(t, s.orgA);
  b = await seedGraph(t, s.orgB);
});
afterAll(() => t.close());

const svc = (sql: string, params: unknown[] = []) => t.asService((tx) => tx.query<Record<string, unknown>>(sql, params));
const UNIQUE = { code: '23505' };

describe('money keeps exact cents', () => {
  it('0.10 + 0.20 stored and summed in the database reads back as exactly "0.30"', async () => {
    const r = await t.asUser(s.orgA.reviewer, async (tx) => {
      const id = (await tx.query<{ id: string }>(
        `insert into invoices (organization_id, status, document_storage_path, document_sha256, extraction, created_by,
           subtotal, tax_amount, total_amount)
         values ($1, 'uploaded', 'p', repeat('f', 64), '{}', $2, $3, $4, $3::numeric + $4::numeric) returning id`,
        [s.orgA.id, s.orgA.reviewer, '0.10', '0.20'])).rows[0].id;
      return (await tx.query('select subtotal, tax_amount, total_amount from invoices where id = $1', [id])).rows[0];
    });
    expect(r).toEqual({ subtotal: '0.10', tax_amount: '0.20', total_amount: '0.30' });
  });

  it('a sum over many line items stays exact', async () => {
    const r = await t.asService(async (tx) => {
      for (let i = 0; i < 10; i++) {
        await tx.query(`insert into invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total)
          values ($1, $2, 'cent', 1, '0.10', '0.10')`, [a.invoice, 100 + i]);
      }
      return (await tx.query<{ s: string }>(
        `select sum(line_total) as s from invoice_line_items where invoice_id = $1 and line_number >= 100`, [a.invoice])).rows[0].s;
    });
    expect(r).toBe('1.00');
  });

  it('the largest numeric(14,2) amount round-trips and one more digit is rejected', async () => {
    const r = await svc(`update purchase_orders set total_amount = '999999999999.99' where id = $1 returning total_amount`, [a.po]);
    expect(r.rows[0].total_amount).toBe('999999999999.99');
    await expect(svc(`update purchase_orders set total_amount = '1000000000000.00' where id = $1`, [a.po])).rejects.toMatchObject({ code: '22003' });
  });

  it('negative amounts (credits, differences) keep their cents', async () => {
    const r = await svc(`update discrepancies set difference_amount = '-12.05' where id = $1 returning difference_amount`, [a.discrepancy]);
    expect(r.rows[0].difference_amount).toBe('-12.05');
  });

  it('quantities keep three decimal places', async () => {
    const r = await svc(`update invoice_line_items set quantity = '1.333' where id = $1 returning quantity`, [a.invoiceLine]);
    expect(r.rows[0].quantity).toBe('1.333');
  });

  it('extraction_confidence must be between 0 and 1', async () => {
    expect((await svc(`update invoices set extraction_confidence = 0.875 where id = $1 returning extraction_confidence`, [a.invoice]))
      .rows[0].extraction_confidence).toBe('0.875');
    await expect(svc(`update invoices set extraction_confidence = 1.5 where id = $1`, [a.invoice])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('uniqueness rules', () => {
  it('a supplier normalized_name is unique within an organisation but may repeat across organisations', async () => {
    await svc(`insert into suppliers (organization_id, supplier_name, normalized_name) values ($1, 'Globex', 'globex')`, [s.orgA.id]);
    await expect(svc(`insert into suppliers (organization_id, supplier_name, normalized_name) values ($1, 'GLOBEX', 'globex')`, [s.orgA.id]))
      .rejects.toMatchObject(UNIQUE);
    await svc(`insert into suppliers (organization_id, supplier_name, normalized_name) values ($1, 'Globex', 'globex')`, [s.orgB.id]);
  });

  it('a purchase order number is unique within an organisation but may repeat across organisations', async () => {
    const ins = (g: Graph) => svc(`insert into purchase_orders (organization_id, supplier_id, purchase_order_number, currency, tax_amount,
      total_amount, status) values ($1, $2, 'PO-SAME', 'GBP', 0, 0, 'open')`, [g.org.id, g.supplier]);
    await ins(a);
    await expect(ins(a)).rejects.toMatchObject(UNIQUE);
    await ins(b);
  });

  it('a line number is unique within an invoice', async () => {
    await expect(svc(`insert into invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total)
      values ($1, 1, 'dup', 1, 1, 1)`, [a.invoice])).rejects.toMatchObject(UNIQUE);
  });

  it('a line number is unique within a purchase order', async () => {
    await expect(svc(`insert into purchase_order_line_items (purchase_order_id, line_number, description, quantity, unit_price, line_total)
      values ($1, 1, 'dup', 1, 1, 1)`, [a.po])).rejects.toMatchObject(UNIQUE);
  });

  it('the same discrepancy (invoice, type, evidence_hash) cannot be recorded twice', async () => {
    await expect(svc(`insert into discrepancies (organization_id, invoice_id, discrepancy_type, severity, status, deterministic_evidence,
      evidence_hash) values ($1, $2, 'incorrect_total', 'low', 'open', '{}', 'h1')`, [s.orgA.id, a.invoice])).rejects.toMatchObject(UNIQUE);
    await svc(`insert into discrepancies (organization_id, invoice_id, discrepancy_type, severity, status, deterministic_evidence,
      evidence_hash) values ($1, $2, 'incorrect_total', 'low', 'open', '{}', 'h2')`, [s.orgA.id, a.invoice]);
  });

  describe('ai_investigations: one live investigation per (discrepancy, evidence_hash, prompt_version, model)', () => {
    const inv = (status: string, hash: string, model = 'model-y') => svc(
      `insert into ai_investigations (organization_id, discrepancy_id, model_identifier, prompt_version, investigation_status,
         evidence_hash, evidence_references, requested_by) values ($1, $2, $3, 'investigate-v1', $4, $5, '[]', $6)`,
      [s.orgA.id, a.discrepancy, model, status, hash, s.orgA.reviewer]);

    it('a second queued investigation for the same key is rejected', async () => {
      await inv('queued', 'k1');
      await expect(inv('queued', 'k1')).rejects.toMatchObject(UNIQUE);
      await expect(inv('completed', 'k1')).rejects.toMatchObject(UNIQUE);
    });

    it('failed investigations do not block a retry, and several failures may accumulate', async () => {
      await inv('failed', 'k2');
      await inv('failed', 'k2');
      await inv('queued', 'k2');
      await expect(inv('in_progress', 'k2')).rejects.toMatchObject(UNIQUE);
    });

    it('a different evidence hash, prompt or model is a different investigation', async () => {
      await inv('completed', 'k3');
      await inv('completed', 'k4');
      await inv('completed', 'k3', 'model-z');
    });
  });

  it('a membership is unique per (user, organisation)', async () => {
    await expect(svc(`insert into organization_memberships (user_id, organization_id, role) values ($1, $2, 'viewer')`,
      [s.orgA.viewer, s.orgA.id])).rejects.toMatchObject(UNIQUE);
  });

  it('a job idempotency_key is globally unique', async () => {
    const ins = (org: string) => svc(`insert into jobs (organization_id, kind, payload, idempotency_key) values ($1, 'k', '{}', 'job-1')`, [org]);
    await ins(s.orgA.id);
    await expect(ins(s.orgB.id)).rejects.toMatchObject(UNIQUE);
  });

  it('an idempotency key is unique per (organisation, key, endpoint)', async () => {
    const ins = (org: string, endpoint: string) => svc(`insert into idempotency_keys (organization_id, key, endpoint, user_id, response,
      status_code) values ($1, 'idem-1', $2, $3, '{}', 201)`, [org, endpoint, s.orgA.admin]);
    await ins(s.orgA.id, 'POST /api/invoices');
    await expect(ins(s.orgA.id, 'POST /api/invoices')).rejects.toMatchObject(UNIQUE);
    await ins(s.orgA.id, 'POST /api/purchase-orders');
    await ins(s.orgB.id, 'POST /api/invoices');
  });
});

describe('enum check constraints match server/contracts exactly', () => {
  const ENUMS: [string, string, { options: readonly string[] }][] = [
    ['organization_memberships', 'role', Role],
    ['invoices', 'status', InvoiceStatus],
    ['discrepancies', 'discrepancy_type', DiscrepancyType],
    ['discrepancies', 'severity', Severity],
    ['discrepancies', 'status', DiscrepancyStatus],
    ['ai_investigations', 'investigation_status', InvestigationStatus],
    ['ai_investigations', 'recommended_action', RecommendedAction],
    ['ai_investigations', 'confidence', Confidence],
    ['resolution_actions', 'proposed_action', RecommendedAction],
    ['resolution_actions', 'approved_action', RecommendedAction],
    ['resolution_actions', 'approval_status', ApprovalStatus],
    ['audit_events', 'actor_type', ActorType],
    ['jobs', 'status', JobStatus],
  ];

  it.each(ENUMS)('%s.%s', async (table, column, zenum) => {
    const r = await svc(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [`${table}_${column}_check`]);
    expect(r.rows).toHaveLength(1);
    const values = [...String(r.rows[0].def).matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
    expect(values).toEqual([...zenum.options].sort());
  });

  it('an unknown invoice status is rejected', async () => {
    await expect(svc(`update invoices set status = 'paid' where id = $1`, [a.invoice])).rejects.toMatchObject({ code: '23514' });
  });
});
