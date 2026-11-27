// The single Vercel Function. vercel.json rewrites /api/(.*) here; req.url keeps the original path.
import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { investigateHandler } from '../server/agent/investigate.ts';
import { FALLBACK_OPENAI_MODEL, openaiModel, scriptedModel } from '../server/agent/model.ts';
import { pgDb } from '../server/db/index.ts';
import { createRouter } from '../server/http/router.ts';
import { supabaseVerifier } from '../server/services/auth.ts';
import { registerJobHandler } from '../server/services/jobs.ts';
import { supabaseStorage } from '../server/services/storage.ts';

let route: ReturnType<typeof createRouter> | undefined;

function router() {
  if (route) return route;
  const env = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const url = env('SUPABASE_URL'), serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  // One id for the request and the run, so the stored model_identifier and the reuse key always agree.
  const model = process.env.AGENT_MODE === 'openai' ? openaiModel(process.env.OPENAI_MODEL || FALLBACK_OPENAI_MODEL, process.env.OPENAI_API_KEY) : scriptedModel();
  const modelId = model.id;
  registerJobHandler('investigate', investigateHandler({ model }));
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const verifyToken = supabaseVerifier(url, serviceKey);
  route = createRouter({
    db: pgDb(env('DATABASE_URL')),
    verifyToken,
    verifyWorkspaceToken: process.env.PUBLIC_SIGNUP === 'true' ? verifyToken : undefined,
    storage: supabaseStorage(url, serviceKey),
    cronSecret: process.env.CRON_SECRET,
    model: modelId,
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 60,
    publicConfig: anonKey ? { supabase_url: url, supabase_anon_key: anonKey } : undefined, // supabase variant only, never 'dev'
    defer: (fn) => waitUntil(fn()),
  });
  return route;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let out;
  try {
    out = await router()({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: req.body });
  } catch {
    out = { status: 500, body: { error: { code: 'internal', message: 'Internal error' } } }; // missing configuration
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(out.status).json(out.body);
}
