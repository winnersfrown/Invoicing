import { randomUUID } from 'node:crypto';
import { asUser } from '../../server/db/index';
import { pgliteDb } from '../api/helpers';
import { seedGraph, ORG_TABLES } from './fixtures';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let testDb: TestDb;
beforeAll(async () => { testDb = await createTestDb({ storage: true }); });
afterAll(() => testDb.close());

it('grants browser roles no application data access or path to the trusted role', async () => {
  const { db } = testDb;
  const grants = await db.query(`select tablename, client, privilege from pg_tables
    cross join unnest(array['anon','authenticated']) client
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
    where schemaname='public' and has_table_privilege(client, format('public.%I', tablename), privilege)`);
  expect(grants.rows).toEqual([]);
  const roles = await db.query(`select rolcanlogin, rolbypassrls, rolsuper,
    pg_has_role('authenticated',oid,'MEMBER') as browser_member from pg_roles where rolname='sorikano_workflow'`);
  expect(roles.rows).toEqual([{ rolcanlogin: false, rolbypassrls: false, rolsuper: false, browser_member: false }]);
  expect((await db.query(`select has_function_privilege('authenticated','public.current_role_in(uuid)','execute') helper,
    has_function_privilege('authenticated','sorikano_private.unlink_invoice_purchase_order(uuid,uuid,uuid)','execute') unlink`)).rows)
    .toEqual([{ helper: false, unlink: false }]);
  expect((await db.query("select policyname from pg_policies where schemaname='storage' and tablename='objects'")).rows).toEqual([]);
  expect((await db.query("select public from storage.buckets where id='invoice-documents'")).rows).toEqual([{ public: false }]);
});

async function makeReviewer() {
  const adapter = pgliteDb(testDb.db);
  const reviewer = randomUUID();
  const [{ id }] = await adapter.query("insert into organizations (name) values ('Test workspace') returning id");
  await adapter.query("insert into organization_memberships (user_id, organization_id, role) values ($1,$2,'reviewer')", [reviewer, id]);
  return seedGraph(testDb, { id, reviewer, admin: reviewer, viewer: reviewer });
}

it('isolates each financial table under the workflow role with two synthetic Reviewers', async () => {
  const { db } = testDb;
  const adapter = pgliteDb(db);
  const a = await makeReviewer(), b = await makeReviewer();
  await adapter.transaction(tx => asUser(tx, a.org.reviewer, async () => {
    for (const spec of ORG_TABLES) {
      expect(await tx.query(`select 1 from ${spec.table} where ${spec.key(a)}`)).toHaveLength(1);
      expect(await tx.query(`select 1 from ${spec.table} where ${spec.key(b)}`)).toHaveLength(0);
    }
  }));
});

it('rolls back financial changes when an audit insert fails', async () => {
  const adapter = pgliteDb(testDb.db);
  const graph = await makeReviewer();
  const [row] = await adapter.query('select id, created_by, status from invoices where id=$1', [graph.invoice]);
  await expect(adapter.transaction(tx => asUser(tx, row.created_by, async () => {
    await tx.query("update invoices set status='exception' where id=$1", [row.id]);
    // Model an unavailable audit sink using its required event_type constraint.
    await tx.query(`insert into audit_events (organization_id, actor_type, actor_id, target_type, target_id)
      select organization_id, 'user', created_by::text, 'invoice', id::text from invoices where id=$1`, [row.id]);
  }))).rejects.toMatchObject({ code: '23502' });
  expect(await adapter.query('select status from invoices where id=$1', [row.id])).toEqual([{ status: row.status }]);
});

it('refuses direct browser financial statements at the database boundary', async () => {
  const { org } = await makeReviewer();
  for (const sql of [
    'select id from invoices limit 0',
    'update invoices set status=status where false',
    'insert into audit_events (event_type) select null where false',
    'insert into resolution_actions (reviewer_id) select null::uuid where false',
  ]) {
    await expect(testDb.asUser(org.reviewer, tx => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
  }
});
