/**
 * In-process Postgres (PGlite) with the pieces of Supabase our migrations rely on, then every
 * file in supabase/migrations applied in name order.
 *
 *   const t = await createTestDb();                 // fresh in-memory database
 *   const s = await seedTwoOrgs(t);                 // s.orgA / s.orgB: { id, admin, reviewer, viewer }; s.outsider
 *   await t.asUser(s.orgA.reviewer, (tx) => tx.query('select * from invoices'));  // RLS applies
 *   await t.asService((tx) => tx.query('insert into jobs ...'));                  // privileged, RLS bypassed
 *   await t.close();
 *
 * asUser(userId, fn): one transaction running `set local role authenticated` and
 *   set_config('request.jwt.claims', {"sub": userId, "role": "authenticated"}, true), the same
 *   thing the server does per request. Commits if fn resolves, rolls back if it throws.
 * asService(fn): one transaction as the connecting superuser (`postgres`), standing in for the
 *   server's privileged pooler connection. Triggers still fire; RLS does not apply.
 * createTestDb({ storage: true }) also creates a minimal stub of Supabase's `storage` schema
 *   (buckets, objects with RLS on) so the storage policies in 0002 can be exercised.
 *
 * What is emulated from Supabase: roles anon / authenticated / service_role, schema `auth` with
 * auth.uid() read from request.jwt.claims, and Supabase's default privileges (everything in
 * `public` granted to anon/authenticated/service_role), so the migrations' own revokes are tested.
 */
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

const SUPABASE_PRELUDE = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const STORAGE_STUB = `
create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
`;

export type Tx = Transaction;

export interface TestDb {
  db: PGlite;
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDb(opts: { storage?: boolean; through?: string } = {}): Promise<TestDb> {
  const db = await PGlite.create();
  await db.exec(SUPABASE_PRELUDE);
  if (opts.storage) await db.exec(STORAGE_STUB);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && (!opts.through || f <= opts.through)).sort()) {
    try {
      await db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'));
    } catch (e) {
      throw new Error(`migration ${file} failed: ${(e as Error).message}`);
    }
  }
  return {
    db,
    asUser: (userId, fn) =>
      db.transaction(async (tx) => {
        await tx.exec('set local role authenticated');
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: userId, role: 'authenticated' }),
        ]);
        return fn(tx);
      }),
    asService: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}

export interface OrgSeed { id: string; admin: string; reviewer: string; viewer: string }
export interface TwoOrgs { orgA: OrgSeed; orgB: OrgSeed; outsider: string }

/** Two organisations, each with an admin, reviewer and viewer, plus a user with no membership. */
export async function seedTwoOrgs(t: TestDb): Promise<TwoOrgs> {
  const make = (name: string) =>
    t.asService(async (tx) => {
      const org: OrgSeed = {
        id: (await tx.query<{ id: string }>('insert into organizations (name) values ($1) returning id', [name])).rows[0].id,
        admin: randomUUID(),
        reviewer: randomUUID(),
        viewer: randomUUID(),
      };
      for (const role of ['admin', 'reviewer', 'viewer'] as const) {
        await tx.query('insert into organization_memberships (user_id, organization_id, role) values ($1, $2, $3)', [org[role], org.id, role]);
      }
      return org;
    });
  return { orgA: await make('Org A'), orgB: await make('Org B'), outsider: randomUUID() };
}
