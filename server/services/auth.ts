import { createClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { Role } from '../contracts/index';
import type { Db } from '../db/index';
import { fail } from './util';

/** Returns the user id for a valid access token, or null. */
export type TokenVerifier = (token: string) => Promise<string | null>;
export type Caller = { userId: string; orgId: string; role: z.infer<typeof Role> };

export function supabaseVerifier(url: string, key: string): TokenVerifier {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return async (token) => {
    const { data, error } = await client.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  };
}

/**
 * Verifies the bearer token and loads the caller's membership (privileged read). The organisation always
 * comes from membership. ponytail: a user in several organisations acts in the oldest membership until the
 * contract adds an organisation selector validated against membership.
 */
export async function authenticate(db: Db, verify: TokenVerifier, header: string | undefined): Promise<Caller> {
  const token = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '')?.[1];
  if (!token) fail('unauthenticated', 'Sign in required');
  const userId = await verify(token!).catch(() => null);
  if (!userId) fail('unauthenticated', 'Sign in required');
  const [m] = await db.query<{ organization_id: string; role: Caller['role'] }>(
    'select organization_id, role from organization_memberships where user_id = $1 order by created_at, organization_id limit 1', [userId]);
  if (!m) fail('forbidden', 'No organisation membership');
  return { userId: userId!, orgId: m.organization_id, role: m.role };
}
