// Invoice documents in storage: private bucket, path-scoped to the organisation, never overwritten or removed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, seedTwoOrgs, type TestDb, type TwoOrgs } from './harness';
import { expectDenied, rowsChanged } from './fixtures';
import { UPLOAD_MAX_BYTES, UPLOAD_MIME_TYPES } from '../../server/contracts/index';

let t: TestDb;
let s: TwoOrgs;
const sha = 'a'.repeat(64);
const pathFor = (org: string) => `${org}/${randomUUID()}/${sha}`;
let aPath: string;
let bPath: string;

const put = (tx: { query: (q: string, p: unknown[]) => Promise<unknown> }, name: string) =>
  tx.query(`insert into storage.objects (bucket_id, name) values ('invoice-documents', $1)`, [name]);

beforeAll(async () => {
  t = await createTestDb({ storage: true });
  s = await seedTwoOrgs(t);
  aPath = pathFor(s.orgA.id);
  bPath = pathFor(s.orgB.id);
  await t.asService(async (tx) => { await put(tx, aPath); await put(tx, bPath); });
});
afterAll(() => t.close());

describe('invoice-documents storage bucket', () => {
  it('migrations also apply where the storage schema does not exist', async () => {
    const plain = await createTestDb();
    const r = await plain.db.query(`select 1 from pg_namespace where nspname = 'storage'`);
    expect(r.rows).toHaveLength(0);
    await plain.close();
  });

  it('the bucket exists, is private, and enforces the upload size and type limits from contracts', async () => {
    const r = await t.asService((tx) => tx.query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      `select public, file_size_limit::int as file_size_limit, allowed_mime_types from storage.buckets where id = 'invoice-documents'`));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].public).toBe(false);
    expect(r.rows[0].file_size_limit).toBe(UPLOAD_MAX_BYTES);
    expect([...r.rows[0].allowed_mime_types].sort()).toEqual([...UPLOAD_MIME_TYPES].sort());
  });

  it.each(['admin', 'reviewer', 'viewer'] as const)('%s of A can read A documents and not B documents', async (role) => {
    const r = await t.asUser(s.orgA[role], (tx) => tx.query<{ name: string }>(`select name from storage.objects`));
    expect(r.rows.map((x) => x.name)).toEqual([aPath]);
  });

  it('a user with no membership reads no documents', async () => {
    const r = await t.asUser(s.outsider, (tx) => tx.query(`select name from storage.objects`));
    expect(r.rows).toHaveLength(0);
  });

  it('reviewer of A can upload under an org A path', async () => {
    await t.asUser(s.orgA.reviewer, (tx) => put(tx, pathFor(s.orgA.id)));
  });

  it('viewer of A cannot upload', async () => {
    await expectDenied(t.asUser(s.orgA.viewer, (tx) => put(tx, pathFor(s.orgA.id))));
  });

  it('reviewer of A cannot upload under an org B path', async () => {
    await expectDenied(t.asUser(s.orgA.reviewer, (tx) => put(tx, pathFor(s.orgB.id))));
  });

  it.each([
    ['no invoice segment', () => `${s.orgA.id}/${sha}`],
    ['extra segment', () => `${s.orgA.id}/${randomUUID()}/${sha}/x`],
    ['non-hex hash', () => `${s.orgA.id}/${randomUUID()}/${'z'.repeat(64)}`],
    ['traversal', () => `../${s.orgA.id}/${randomUUID()}/${sha}`],
  ])('reviewer cannot upload to a malformed path (%s)', async (_n, name) => {
    await expectDenied(t.asUser(s.orgA.reviewer, (tx) => put(tx, name())));
  });

  it('reviewer cannot upload an org-A-shaped path into another bucket', async () => {
    await t.asService((tx) => tx.query(`insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing`));
    await expectDenied(t.asUser(s.orgA.reviewer, (tx) =>
      tx.query(`insert into storage.objects (bucket_id, name) values ('other', $1)`, [pathFor(s.orgA.id)])));
  });

  it.each(['admin', 'reviewer'] as const)('%s cannot overwrite or delete a document', async (role) => {
    expect(await rowsChanged(t, s.orgA[role], `update storage.objects set name = name || 'x' where name = '${aPath}'`)).toBe(0);
    expect(await rowsChanged(t, s.orgA[role], `delete from storage.objects where name = '${aPath}'`)).toBe(0);
    const r = await t.asService((tx) => tx.query(`select 1 from storage.objects where name = $1`, [aPath]));
    expect(r.rows).toHaveLength(1);
  });
});
