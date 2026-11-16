// Local development server: dist/ as static files, the real router at /api, PGlite with the real migrations,
// in-memory storage, three fake users, the spec scenario seeded, jobs run in-process. Never for production.
//   npm run dev            (PORT, default 8787; OPENAI_API_KEY set = real OpenAI model, else the scripted one)
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { investigateHandler } from '../server/agent/investigate';
import { FALLBACK_OPENAI_MODEL, openaiModel, scriptedModel } from '../server/agent/model';
import { createRouter } from '../server/http/router';
import { registerJobHandler, runJobs } from '../server/services/jobs';
import { memoryStorage } from '../server/services/storage';
import { extracted, fileOf, pgliteDb, poBody } from '../tests-server/api/helpers';
import { createTestDb } from '../tests-server/db/harness';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const MAX_BODY = 5 * 1024 * 1024;

export async function startDevServer(o: { port?: number; env?: Record<string, string | undefined>; log?: (e: Record<string, unknown>) => void } = {}) {
  const env = o.env ?? process.env;
  if (env.VERCEL || env.NODE_ENV === 'production') throw new Error('The dev server refuses to start in production (VERCEL or NODE_ENV=production is set).');
  const log = o.log ?? ((e) => console.log(JSON.stringify(e)));

  const t = await createTestDb();
  const db = pgliteDb(t.db);
  const model = env.OPENAI_API_KEY ? openaiModel(env.OPENAI_MODEL || FALLBACK_OPENAI_MODEL, env.OPENAI_API_KEY) : scriptedModel();
  registerJobHandler('investigate', investigateHandler({ model }));

  const [org] = await db.query<{ id: string }>(`insert into organizations (name) values ('Dev Org') returning id`);
  const users = (['admin', 'reviewer', 'viewer'] as const).map((role) => ({ label: `Dev ${role}`, role, token: `dev-${role}`, id: randomUUID() }));
  for (const u of users) await db.query('insert into organization_memberships (user_id, organization_id, role) values ($1, $2, $3)', [u.id, org.id, u.role]);
  const byToken = new Map(users.map((u) => [u.token, u.id]));

  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => { const q = p.catch(() => {}).finally(() => pending.delete(q)); pending.add(q); };
  const router = createRouter({ db, storage: memoryStorage(), verifyToken: async (tok) => byToken.get(tok) ?? null, model: model.id, log, defer: (fn) => track(fn()) });
  // Retry sweep, standing in for the scheduled /api/jobs/run.
  const sweep = setInterval(() => track(runJobs(db)), 5000);

  // The spec scenario: PO 12 x 40.00 = 480.00, invoice 12 x 45.00 = 540.00 from Example Office Supply.
  const reviewer = { authorization: 'Bearer dev-reviewer' };
  const line = { sku: 'PAPER-A4', description: 'A4 copy paper, box', quantity: 12, tax_amount: null };
  const po = await router({ method: 'POST', url: '/api/purchase-orders', headers: { ...reviewer, 'idempotency-key': randomUUID() },
    body: poBody({ supplier_name: 'Example Office Supply', lines: [{ ...line, unit_price: '40.00', line_total: '480.00' }] }) });
  const ex = extracted({ supplier_name: 'Example Office Supply', invoice_number: 'INV-1001', lines: [{ ...line, unit_price: '45.00', line_total: '540.00' }],
    source_text: 'Example Office Supply invoice for A4 copy paper boxes delivered to head office' });
  const inv = await router({ method: 'POST', url: '/api/invoices', headers: { ...reviewer, 'idempotency-key': randomUUID() },
    body: { file: fileOf(Buffer.from(JSON.stringify(ex))), extracted: ex } });
  if (po.status !== 201 || inv.status !== 201) throw new Error('Seeding the dev scenario failed.');

  const config = { data: { mode: 'dev', dev_users: users.map(({ label, token, role }) => ({ label, token, role })) } };

  const server = createServer(async (req, res) => {
    const send = (status: number, body: string | Buffer, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    };
    try {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      if (path === '/api/config') return send(200, JSON.stringify(config));
      if (path.startsWith('/api/')) {
        const raw = await readBody(req);
        let body: unknown;
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined; } catch { return send(400, JSON.stringify({ error: { code: 'invalid_request', message: 'Invalid JSON' } })); }
        const out = await router({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body });
        return send(out.status, JSON.stringify(out.body));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed', 'text/plain');
      const file = resolve(DIST, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)) return send(404, 'Not found', 'text/plain');
      const bytes = await readFile(file).catch(() => null);
      return bytes ? send(200, bytes, TYPES[extname(file)] ?? 'application/octet-stream') : send(404, 'Not found', 'text/plain');
    } catch {
      return send(500, JSON.stringify({ error: { code: 'internal', message: 'Internal error' } }));
    }
  });
  await new Promise<void>((ok) => server.listen(o.port ?? (Number(env.PORT) || 8787), '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url, users: config.data.dev_users, model: model.id,
    async close() {
      clearInterval(sweep);
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      await Promise.all(pending);
      await t.close();
    },
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(); fail(new Error('Body too large')); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startDevServer();
  console.log(`Rekono dev server on ${s.url} (model: ${s.model}). Dev users: ${s.users.map((u) => `${u.role}=${u.token}`).join(', ')}`);
  const stop = () => { s.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
