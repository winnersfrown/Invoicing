import { createClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { Role } from '../contracts/index.ts';
import type { Db } from '../db/index.ts';
import { fail } from './util.ts';

/** Returns the user id for a valid access token, or null. */
export type TokenVerifier = (token: string) => Promise<string | null>;
export type Caller = { userId: string; orgId: string; role: z.infer<typeof Role> };

export function supabaseVerifier(url: string, key: string, { verifiedEmail = false } = {}): TokenVerifier {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return async (token) => {
    const { data, error } = await client.auth.getUser(token);
    const user = data.user;
    if (error || !user) return null;
    if (verifiedEmail && (user.is_anonymous || !user.email || !user.email_confirmed_at)) return null;
    return user.id;
  };
}

export async function verifyBearer(verify: TokenVerifier, header: string | undefined): Promise<string> {
  const token = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? '')?.[1];
  const userId = token ? await verify(token).catch(() => null) : null;
  return userId ?? fail('unauthenticated', 'Sign in required');
}

export async function getMembership(db: Db, userId: string): Promise<Caller | undefined> {
  const [membership] = await db.query<{ organization_id: string; role: Caller['role'] }>(
    'select organization_id, role from organization_memberships where user_id = $1 order by created_at, organization_id limit 1', [userId]);
  if (membership) return { userId, orgId: membership.organization_id, role: membership.role };
}

export function requireReviewer(caller: Caller): Caller {
  if (caller.role !== 'reviewer') fail('forbidden', 'Your workspace access needs review. Contact Sorikano support.');
  return caller;
}

/** Authenticates a Reviewer in their original workspace. The oldest membership is the default for existing multi-organization users. */
export async function authenticate(db: Db, verify: TokenVerifier, header: string | undefined): Promise<Caller> {
  const userId = await verifyBearer(verify, header);
  return requireReviewer(await getMembership(db, userId) ?? fail('forbidden', 'No organisation membership'));
}
