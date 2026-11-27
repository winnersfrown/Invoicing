import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { pgliteDb } from '../api/helpers';
import { createRouter } from '../../server/http/router';
import { memoryStorage } from '../../server/services/storage';

const migration = readFileSync(new URL('../../supabase/migrations/0004_reviewer_only.sql', import.meta.url), 'utf8');
let testDb: TestDb;
beforeAll(async () => { testDb = await createTestDb({ storage: true, through: '0003_invoice_management.sql' }); });
afterAll(() => testDb?.close());

it('stops on shared legacy access and converts sole memberships in place when clear', async () => {
  const partner = randomUUID();
  const legacyAdmin = randomUUID();
  const legacyViewer = randomUUID();
  const existingReviewer = randomUUID();
  const { db } = testDb;
  const dbAdapter = pgliteDb(db);
  const route = createRouter({ db: dbAdapter, storage: memoryStorage(),
    verifyToken: async token => token, verifyWorkspaceToken: async token => token, log: () => {} });
  const report = (user: string, path = '/api/invoices', method = 'GET') =>
    route({ method, url: path, headers: { authorization: `Bearer ${user}` } });
  const [adminOrg, viewerOrg, reviewerOrg] = (await db.query<{ id: string }>(
    "insert into organizations (name) values ('Original business'), ('Original viewer'), ('Existing demo') returning id")).rows;
  await db.query(`insert into organization_memberships (organization_id, user_id, role)
    values ($1, $2, 'admin'), ($1, $3, 'reviewer'), ($4, $5, 'viewer'), ($6, $7, 'reviewer')`,
  [adminOrg.id, legacyAdmin, partner, viewerOrg.id, legacyViewer, reviewerOrg.id, existingReviewer]);
  await db.query(`insert into audit_events (organization_id, actor_type, event_type, target_type, target_id)
    values ($1, 'system', 'existing.history', 'organization', $1::uuid::text)`, [adminOrg.id]);

  expect((await report(legacyViewer)).status).toBe(403);
  expect((await report(legacyAdmin, '/api/workspace', 'POST')).status).toBe(403);
  await expect(db.exec(migration)).rejects.toThrow(/Shared organizations have legacy roles/);
  expect((await db.query('select role from organization_memberships where user_id = $1', [legacyViewer])).rows).toEqual([{ role: 'viewer' }]);
  expect((await db.query("select 1 from audit_events where event_type = 'membership.role_changed'")).rows).toEqual([]);

  // Remove only the synthetic blocker to exercise the safe path in the same isolated database.
  await db.query('delete from organization_memberships where user_id = $1', [partner]);
  const before = (await db.query('select user_id, organization_id, created_at from organization_memberships order by user_id')).rows;
  await db.exec(migration);
  await db.exec(readFileSync(new URL('../../supabase/migrations/0005_workflow_role.sql', import.meta.url), 'utf8'));
  const after = (await db.query('select user_id, organization_id, created_at from organization_memberships order by user_id')).rows;
  expect(after).toEqual(before);

  for (const user of [legacyAdmin, legacyViewer, existingReviewer]) {
    expect((await report(user)).status).toBe(200);
    expect((await report(user, '/api/workspace', 'POST')).body).toEqual({ data: { role: 'reviewer' } });
  }
  expect((await db.query('select id from organizations')).rows).toHaveLength(3);
  expect((await db.query("select 1 from audit_events where event_type = 'existing.history'")).rows).toHaveLength(1);
  const changes = (await db.query("select target_id, previous_state, new_state from audit_events where event_type = 'membership.role_changed'")).rows;
  expect(changes).toHaveLength(2);
  for (const [target_id, previousRole] of [[legacyAdmin, 'admin'], [legacyViewer, 'viewer']]) {
    expect(changes).toContainEqual({ target_id, previous_state: { role: previousRole }, new_state: { role: 'reviewer' } });
    await expect(db.query('update organization_memberships set role = $1 where user_id = $2', [previousRole, target_id]))
      .rejects.toMatchObject({ code: '23514' });
  }
  const visible = await testDb.asUser(legacyAdmin, tx => tx.query('select id from organizations'));
  expect(visible.rows).toEqual([adminOrg]);
  const filePath = (organization: string) => `${organization}/${randomUUID()}/${'a'.repeat(64)}`;
  const ownPath = filePath(adminOrg.id);
  const otherPath = filePath(viewerOrg.id);
  await db.query("insert into storage.objects (bucket_id, name) values ('invoice-documents', $1), ('invoice-documents', $2)", [ownPath, otherPath]);
  const files = await testDb.asUser(legacyAdmin, tx => tx.query('select name from storage.objects'));
  expect(files.rows).toEqual([{ name: ownPath }]);
  await expect(testDb.asUser(legacyAdmin, tx => tx.query(
    "insert into storage.objects (bucket_id, name) values ('invoice-documents', $1)", [filePath(viewerOrg.id)],
  ))).rejects.toMatchObject({ code: '42501' });
  await expect(testDb.asUser(legacyAdmin, tx => tx.query(
    "insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'reviewer')", [adminOrg.id, randomUUID()],
  ))).rejects.toMatchObject({ code: '42501' });
});
