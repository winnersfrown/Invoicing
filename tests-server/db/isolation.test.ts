// Organisation isolation: row-level security keeps every organisation's data private.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTwoOrgs, type TestDb, type TwoOrgs } from './harness';
import {
  ALL_TABLES, MEMBERSHIPS, ORGANIZATIONS, ORG_TABLES, expectDenied, rowsChanged, seedGraph, snapshot, type Graph,
} from './fixtures';

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

const VISIBLE_TABLES = [ORGANIZATIONS, MEMBERSHIPS, ...ORG_TABLES];

describe('a member of org A cannot touch org B rows', () => {
  describe.each(VISIBLE_TABLES)('$table', (spec) => {
    it.each(['admin', 'reviewer', 'viewer'] as const)('%s of A cannot select the org B row', async (role) => {
      const r = await t.asUser(s.orgA[role], (tx) => tx.query(`select * from ${spec.table} where ${spec.key(b)}`));
      expect(r.rows).toHaveLength(0);
    });

    it('admin of A sees only org A rows when selecting everything', async () => {
      const col = spec.table === 'organizations' ? 'id' : spec.table.endsWith('line_items') ? null : 'organization_id';
      if (!col) return; // line items carry no organization_id; covered by the per-row check above
      const r = await t.asUser(s.orgA.admin, (tx) => tx.query<{ o: string }>(`select distinct ${col}::text as o from ${spec.table}`));
      expect(r.rows.map((x) => x.o)).toEqual([s.orgA.id]);
    });

    it('admin of A cannot update the org B row', async () => {
      const before = await snapshot(t, spec, b);
      expect(await rowsChanged(t, s.orgA.admin, `update ${spec.table} set ${spec.set} where ${spec.key(b)}`)).toBe(0);
      expect(await snapshot(t, spec, b)).toEqual(before);
    });

    it('admin of A cannot delete the org B row', async () => {
      expect(await rowsChanged(t, s.orgA.admin, `delete from ${spec.table} where ${spec.key(b)}`)).toBe(0);
      expect(await snapshot(t, spec, b)).not.toBeNull();
    });
  });

  it.each([MEMBERSHIPS, ...ORG_TABLES])('admin of A cannot insert a row into org B: $table', async (spec) => {
    await expectDenied(t.asUser(s.orgA.admin, (tx) => tx.query(spec.insert(b))));
  });

  it('admin of A cannot grant themselves a membership in org B', async () => {
    await expectDenied(t.asUser(s.orgA.admin, (tx) => tx.query(
      `insert into organization_memberships (user_id, organization_id, role) values ($1, $2, 'admin')`, [s.orgA.admin, s.orgB.id])));
  });

  it('reviewer of A cannot move an org A row into org B', async () => {
    const before = await snapshot(t, ORG_TABLES[0], a);
    expect(await rowsChanged(t, s.orgA.reviewer, `update suppliers set organization_id = '${s.orgB.id}' where id = '${a.supplier}'`)).toBe(0);
    expect(await snapshot(t, ORG_TABLES[0], a)).toEqual(before);
  });
});

describe('an org A row cannot reference an org B parent', () => {
  const crossRefs: [string, (a: Graph, b: Graph) => string][] = [
    ['discrepancy on an org B invoice', (a, b) => `insert into discrepancies (organization_id, invoice_id, discrepancy_type, severity,
      status, deterministic_evidence, evidence_hash) values ('${a.org.id}', '${b.invoice}', 'incorrect_total', 'high', 'open', '{}', 'x')`],
    ['invoice pointing at an org B purchase order', (a, b) => `insert into invoices (organization_id, purchase_order_id, status,
      document_storage_path, document_sha256, extraction, created_by)
      values ('${a.org.id}', '${b.po}', 'uploaded', 'p', repeat('c', 64), '{}', '${a.org.reviewer}')`],
    ['invoice pointing at an org B supplier', (a, b) => `insert into invoices (organization_id, supplier_id, status,
      document_storage_path, document_sha256, extraction, created_by)
      values ('${a.org.id}', '${b.supplier}', 'uploaded', 'p', repeat('c', 64), '{}', '${a.org.reviewer}')`],
    ['tool call on an org B investigation', (a, b) => `insert into tool_calls (organization_id, investigation_id, tool_name, arguments,
      ok, duration_ms) values ('${a.org.id}', '${b.investigation}', 'get_invoice', '{}', true, 1)`],
    ['resolution on an org B discrepancy', (a, b) => `insert into resolution_actions (organization_id, discrepancy_id, reviewer_id,
      approval_status, reviewer_notes) values ('${a.org.id}', '${b.discrepancy}', '${a.org.reviewer}', 'approved', '')`],
  ];

  it.each(crossRefs)('rejected even through the privileged connection: %s', async (_name, sql) => {
    await expect(t.asService((tx) => tx.query(sql(a, b)))).rejects.toMatchObject({ code: '23503' });
  });

  it('reviewer of A cannot add a line item to an org B invoice', async () => {
    await expectDenied(t.asUser(s.orgA.reviewer, (tx) => tx.query(
      `insert into invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total)
       values ($1, 99, 'd', 1, 1, 1)`, [b.invoice])));
  });

  it('reviewer of A cannot re-parent an org A line item onto an org B invoice', async () => {
    const spec = ORG_TABLES.find((x) => x.table === 'invoice_line_items')!;
    const before = await snapshot(t, spec, a);
    expect(await rowsChanged(t, s.orgA.reviewer, `update invoice_line_items set invoice_id = '${b.invoice}' where id = '${a.invoiceLine}'`)).toBe(0);
    expect(await snapshot(t, spec, a)).toEqual(before);
  });
});

describe('a user with no membership sees nothing', () => {
  it.each(ALL_TABLES.filter((x) => !['jobs', 'idempotency_keys'].includes(x)))('%s is empty for an outsider', async (table) => {
    const r = await t.asUser(s.outsider, (tx) => tx.query(`select * from ${table}`));
    expect(r.rows).toHaveLength(0);
  });

  it.each(ORG_TABLES)('outsider cannot insert into org A: $table', async (spec) => {
    await expectDenied(t.asUser(s.outsider, (tx) => tx.query(spec.insert(a))));
  });

  it('a request with no user id in the claims sees nothing', async () => {
    const r = await t.db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      return tx.query('select * from invoices');
    });
    expect(r.rows).toHaveLength(0);
  });

  it.each(ALL_TABLES)('the anon role cannot read %s', async (table) => {
    await expectDenied(t.db.transaction(async (tx) => {
      await tx.exec('set local role anon');
      return tx.query(`select * from ${table}`);
    }));
  });
});
