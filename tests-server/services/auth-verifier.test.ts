import { afterEach, expect, it, vi } from 'vitest';
import { supabaseVerifier, verifyBearer } from '../../server/services/auth';

afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  ['verified', 200, { id: 'user', email: 'test@example.test', email_confirmed_at: '2026-01-01' }, 'user'],
  ['unconfirmed', 200, { id: 'user', email: 'test@example.test' }, null],
  ['anonymous', 200, { id: 'user', is_anonymous: true, email: 'test@example.test', email_confirmed_at: '2026-01-01' }, null],
  ['expired', 401, { message: 'Token expired' }, null],
  ['invalid', 403, { message: 'Invalid token' }, null],
] as const)('handles the Auth service response for a %s session', async (_, status, body, expected) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
  const verify = supabaseVerifier('https://example.test', 'test-key');
  if (expected) expect(await verifyBearer(verify, 'Bearer fixture')).toBe(expected);
  else await expect(verifyBearer(verify, 'Bearer fixture')).rejects.toMatchObject({ message: 'Sign in required' });
});
