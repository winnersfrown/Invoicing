// Thin fetch wrapper for the Sorikano API (server/contracts/index.ts). No DOM access: unit-tested under node --test.
export const TERMINAL = ['completed', 'insufficient_evidence', 'failed'];
const CODES = {401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 400: 'invalid_request', 409: 'conflict', 429: 'rate_limited'};
const TRANSIENT = new Set(['network', 'internal', 'rate_limited']);
const MESSAGES = {
  unauthenticated: 'Your session has ended. Sign in again.',
  forbidden: 'Your role does not allow this action.',
  not_found: 'This record was not found. It may have been removed or belong to another workspace.',
  invalid_request: 'The server did not accept this request.',
  conflict: 'This record changed while you were working. The view has been refreshed; review it and try again.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  internal: 'Something went wrong on the server. Try again.',
  network: 'Could not reach the server. Check your connection and try again.',
};

export class ApiError extends Error {
  constructor(code, message, status = 0) { super(message); this.code = code; this.status = status; }
}

/** Plain-language message for an error code. Server messages are kept where they explain the specific problem. */
export function errorMessage(code, serverMessage = '') {
  if ((code === 'conflict' || code === 'invalid_request') && serverMessage && serverMessage !== 'Invalid request') return serverMessage;
  return MESSAGES[code] ?? 'Something went wrong. Try again.';
}

const validConfig = c => c && ((c.mode === 'dev' && Array.isArray(c.dev_users)) || (c.mode === 'supabase' && typeof c.supabase_url === 'string' && typeof c.supabase_anon_key === 'string')) ? c : null;

export function createApiClient({fetch: f = (...a) => globalThis.fetch(...a), base = '', getToken = async () => null, onUnauthenticated = () => {},
  newKey = () => crypto.randomUUID(), sleep = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  const pending = new Map(); // action signature -> Idempotency-Key, kept until the action gets a definitive answer

  async function request(method, path, body, key) {
    const headers = {Accept: 'application/json'};
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res, payload;
    try { res = await f(base + path, {method, headers, ...(body !== undefined ? {body: JSON.stringify(body)} : {})}); }
    catch { throw new ApiError('network', errorMessage('network')); }
    try { payload = await res.json(); } catch { payload = null; }
    if (res.ok && payload && 'data' in payload) return payload.data;
    const code = payload?.error?.code ?? CODES[res.status] ?? 'internal';
    if (code === 'unauthenticated') onUnauthenticated();
    throw new ApiError(code, errorMessage(code, payload?.error?.message), res.status);
  }

  return {
    /** ConfigDto, or null when the API is unreachable (static hosting): the app then stays in local demo mode. */
    async loadConfig() {
      try {
        const res = await f(base + '/api/config', {method: 'GET', headers: {Accept: 'application/json'}});
        if (!res.ok) return null;
        const body = await res.json();
        return validConfig(body?.data ?? body);
      } catch { return null; }
    },
    get: path => request('GET', path),
    /** Mutating call. Re-sending the same method, path and body after a transient failure reuses the Idempotency-Key. */
    async send(method, path, body = {}) {
      const sig = `${method} ${path} ${JSON.stringify(body)}`;
      const key = pending.get(sig) ?? newKey();
      pending.set(sig, key);
      try {
        const data = await request(method, path, body, key);
        pending.delete(sig);
        return data;
      } catch (e) {
        if (!TRANSIENT.has(e.code)) pending.delete(sig);
        throw e;
      }
    },
    /** Polls until a terminal status, the signal aborts, or maxWaitMs passes; returns the last investigation seen. */
    async pollInvestigation(id, {onUpdate = () => {}, signal, delays = [1000, 1500, 2500, 4000, 6000, 10000], maxWaitMs = 10 * 60 * 1000} = {}) {
      let last = null, waited = 0;
      for (let i = 0; ; i++) {
        try {
          last = await request('GET', `/api/investigations/${encodeURIComponent(id)}`);
          onUpdate(last);
          if (TERMINAL.includes(last.investigation_status)) return last;
        } catch (e) {
          if (!TRANSIENT.has(e.code)) throw e;
        }
        const wait = delays[Math.min(i, delays.length - 1)];
        if (signal?.aborted || waited + wait > maxWaitMs) return last;
        await sleep(wait);
        waited += wait;
        if (signal?.aborted) return last;
      }
    },
  };
}
