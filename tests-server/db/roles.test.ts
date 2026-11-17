// Roles inside one organisation: viewers read, reviewers write, only admins manage memberships.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTwoOrgs, type TestDb, type TwoOrgs } from './harness';
import { MEMBERSHIPS, ORGANIZATIONS, ORG_TABLES, expectDenied, rowsChanged, seedGraph, snapshot, type Graph } from './fixtures';

let t: TestDb;
let s: TwoOrgs;
let a: Graph;

beforeAll(async () => {
  t = await createTestDb();
  s = await seedTwoOrgs(t);
  a = await seedGraph(t, s.orgA);
});
afterAll(() => t.close());

describe('a viewer can read but cannot write', () => {
  describe.each(ORG_TABLES)('$table', (spec) => {
    it('viewer can read the row', async () => {
      const r = await t.asUser(s.orgA.viewer, (tx) => tx.query(`select * from ${spec.table} where ${spec.key(a)}`));
      expect(r.rows).toHaveLength(1);
    });
    it('viewer cannot insert', async () => {
      await expectDenied(t.asUser(s.orgA.viewer, (tx) => tx.query(spec.insert(a))));
    });
    it('viewer cannot update', async () => {
      const before = await snapshot(t, spec, a);
      expect(await rowsChanged(t, s.orgA.viewer, `update ${spec.table} set ${spec.set} where ${spec.key(a)}`)).toBe(0);
      expect(await snapshot(t, spec, a)).toEqual(before);
    });
    it('viewer cannot delete', async () => {
      expect(await rowsChanged(t, s.orgA.viewer, `delete from ${spec.table} where ${spec.key(a)}`)).toBe(0);
      expect(await snapshot(t, spec, a)).not.toBeNull();
    });
  });
});

describe('a reviewer can write organisation data', () => {
  it.each(ORG_TABLES)('reviewer can insert into $table', async (spec) => {
    const r = await t.asUser(s.orgA.reviewer, (tx) => tx.query(spec.insert(a)));
    expect(r.affectedRows).toBe(1);
  });

  it.each(ORG_TABLES.filter((x) => !x.appendOnly))('reviewer can update $table', async (spec) => {
    expect(await rowsChanged(t, s.orgA.reviewer, `update ${spec.table} set ${spec.set} where ${spec.key(a)}`)).toBe(1);
  });

  it.each(ORG_TABLES.filter((x) => x.deletable))('reviewer can delete an unreferenced row from $table', async (spec) => {
    const n = await t.asUser(s.orgA.reviewer, async (tx) => {
      const id = (await tx.query<{ id: string }>(`${spec.insert(a)} returning id`)).rows[0].id;
      return (await tx.query(`delete from ${spec.table} where id = $1`, [id])).affectedRows;
    });
    expect(n).toBe(1);
  });

  it('only suppliers are deletable among organisation data tables', () => {
    expect(ORG_TABLES.filter((x) => x.deletable).map((x) => x.table)).toEqual(['suppliers']);
  });
});

describe('financial evidence cannot be deleted by any user, even when nothing references it', () => {
  // invoices are covered in audit-trail.test.ts; append-only tables there too
  const EVIDENCE = ORG_TABLES.filter((x) => !x.deletable && !x.appendOnly && x.table !== 'invoices');

  it('covers line items, purchase orders, discrepancies and investigations', () => {
    expect(EVIDENCE.map((x) => x.table).sort()).toEqual(
      ['ai_investigations', 'discrepancies', 'invoice_line_items', 'purchase_order_line_items', 'purchase_orders']);
  });

  describe.each(EVIDENCE)('$table', (spec) => {
    it.each(['admin', 'reviewer', 'viewer'] as const)('%s cannot delete a fresh, unreferenced row', async (role) => {
      const id = await t.asUser(s.orgA.reviewer, async (tx) =>
        (await tx.query<{ id: string }>(`${spec.insert(a)} returning id`)).rows[0].id);
      expect(await rowsChanged(t, s.orgA[role], `delete from ${spec.table} where id = '${id}'`)).toBe(0);
      const r = await t.asService((tx) => tx.query(`select 1 from ${spec.table} where id = $1`, [id]));
      expect(r.rows).toHaveLength(1);
    });
  });
});

describe('only an admin can change memberships', () => {
  it.each(['reviewer', 'viewer'] as const)('%s cannot add a member', async (role) => {
    await expectDenied(t.asUser(s.orgA[role], (tx) => tx.query(MEMBERSHIPS.insert(a))));
  });

  it.each(['reviewer', 'viewer'] as const)('%s cannot promote themselves to admin', async (role) => {
    expect(await rowsChanged(t, s.orgA[role], `update organization_memberships set role = 'admin'
      where user_id = '${s.orgA[role]}' and organization_id = '${s.orgA.id}'`)).toBe(0);
    const r = await t.asService((tx) => tx.query<{ role: string }>(
      'select role from organization_memberships where user_id = $1 and organization_id = $2', [s.orgA[role], s.orgA.id]));
    expect(r.rows[0].role).toBe(role);
  });

  it.each(['reviewer', 'viewer'] as const)('%s cannot remove a member', async (role) => {
    expect(await rowsChanged(t, s.orgA[role], `delete from organization_memberships where ${MEMBERSHIPS.key(a)}`)).toBe(0);
    expect(await snapshot(t, MEMBERSHIPS, a)).not.toBeNull();
  });

  it('members can see who else is in their organisation', async () => {
    const r = await t.asUser(s.orgA.viewer, (tx) => tx.query('select * from organization_memberships'));
    expect(r.rows).toHaveLength(3);
  });

  it('admin can add a member, change their role and remove them', async () => {
    const user = crypto.randomUUID();
    await t.asUser(s.orgA.admin, async (tx) => {
      await tx.query(`insert into organization_memberships (user_id, organization_id, role) values ($1, $2, 'viewer')`, [user, s.orgA.id]);
      expect((await tx.query(`update organization_memberships set role = 'reviewer' where user_id = $1`, [user])).affectedRows).toBe(1);
      expect((await tx.query(`delete from organization_memberships where user_id = $1`, [user])).affectedRows).toBe(1);
    });
  });

  it('a membership role outside admin/reviewer/viewer is rejected', async () => {
    await expect(t.asService((tx) => tx.query(
      `insert into organization_memberships (user_id, organization_id, role) values (gen_random_uuid(), $1, 'owner')`, [s.orgA.id],
    ))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('organisations', () => {
  it.each(['admin', 'reviewer', 'viewer'] as const)('%s cannot create an organisation', async (role) => {
    await expectDenied(t.asUser(s.orgA[role], (tx) => tx.query(ORGANIZATIONS.insert(a))));
  });

  it.each(['reviewer', 'viewer'] as const)('%s cannot rename the organisation', async (role) => {
    expect(await rowsChanged(t, s.orgA[role], `update organizations set name = 'x' where id = '${s.orgA.id}'`)).toBe(0);
  });

  it('admin can rename the organisation', async () => {
    expect(await rowsChanged(t, s.orgA.admin, `update organizations set name = 'Org A Ltd' where id = '${s.orgA.id}'`)).toBe(1);
  });

  it('nobody can delete an organisation', async () => {
    expect(await rowsChanged(t, s.orgA.admin, `delete from organizations where id = '${s.orgA.id}'`)).toBe(0);
    expect(await snapshot(t, ORGANIZATIONS, a)).not.toBeNull();
  });
});
