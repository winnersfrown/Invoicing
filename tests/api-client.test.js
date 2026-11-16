import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient, errorMessage, ApiError, TERMINAL} from '../dist/api-client.js';

const json = (status, body) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const html = status => ({ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <'); }});
function stub(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({url, ...init, headers: {...(init.headers || {})}});
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next;
  };
  return {fetch, calls};
}
let n = 0;
const client = (fetch, extra = {}) => createApiClient({fetch, getToken: async () => 'tok-1', newKey: () => `key-${++n}-abcdef`, sleep: async () => {}, ...extra});

test('get unwraps { data } and sends the bearer token without an idempotency key', async () => {
  const {fetch, calls} = stub([json(200, {data: [{id: 'a'}]})]);
  assert.deepEqual(await client(fetch).get('/api/invoices'), [{id: 'a'}]);
  assert.equal(calls[0].url, '/api/invoices');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
  assert.equal(calls[0].headers['Idempotency-Key'], undefined);
});

test('error envelopes become ApiError with a plain message; non-JSON failures map from the HTTP status', async () => {
  const {fetch} = stub([json(403, {error: {code: 'forbidden', message: 'Your role does not allow this action'}}), html(502), json(409, {error: {code: 'conflict', message: 'This discrepancy is already resolved.'}})]);
  const api = client(fetch);
  await assert.rejects(api.get('/api/invoices'), e => e instanceof ApiError && e.code === 'forbidden' && e.status === 403 && /role/i.test(e.message));
  await assert.rejects(api.get('/api/invoices'), e => e.code === 'internal' && /server/i.test(e.message));
  await assert.rejects(api.send('POST', '/api/discrepancies/x/resolve', {decision: 'rejected'}), e => e.code === 'conflict' && e.message === 'This discrepancy is already resolved.');
});

test('errorMessage covers every contract code and network failure', () => {
  for (const code of ['unauthenticated', 'forbidden', 'not_found', 'invalid_request', 'conflict', 'rate_limited', 'internal', 'network']) {
    assert.ok(errorMessage(code).length > 10, code);
  }
  assert.match(errorMessage('invalid_request', 'Invalid request: extracted.total_amount'), /extracted\.total_amount/);
  assert.match(errorMessage('something_new'), /went wrong/);
});

test('a retried action reuses its Idempotency-Key; a new action after success gets a new one', async () => {
  const {fetch, calls} = stub([new TypeError('Failed to fetch'), json(500, {error: {code: 'internal', message: 'Internal error'}}), json(202, {data: {id: 'inv-1'}}), json(202, {data: {id: 'inv-2'}})]);
  const api = client(fetch);
  const send = () => api.send('POST', '/api/discrepancies/d1/investigate', {});
  await assert.rejects(send(), e => e.code === 'network');
  await assert.rejects(send(), e => e.code === 'internal');
  assert.deepEqual(await send(), {id: 'inv-1'});
  await send();
  const keys = calls.map(c => c.headers['Idempotency-Key']);
  assert.ok(keys[0] && /^[A-Za-z0-9._:-]{8,128}$/.test(keys[0]));
  assert.equal(keys[1], keys[0]);
  assert.equal(keys[2], keys[0]);
  assert.notEqual(keys[3], keys[0]);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].body, '{}');
});

test('a different body is a different action; a definitive rejection releases the key', async () => {
  const {fetch, calls} = stub([new TypeError('offline'), json(200, {data: 1}), json(409, {error: {code: 'conflict', message: 'Changed'}}), json(200, {data: 2})]);
  const api = client(fetch);
  const resolve = notes => api.send('POST', '/api/discrepancies/d1/resolve', {decision: 'rejected', notes});
  await assert.rejects(resolve('a'));
  await resolve('b');
  await assert.rejects(resolve('c'));
  await resolve('c');
  const keys = calls.map(c => c.headers['Idempotency-Key']);
  assert.notEqual(keys[1], keys[0]);
  assert.notEqual(keys[3], keys[2]);
});

test('unauthenticated responses notify the app', async () => {
  let signedOut = 0;
  const {fetch} = stub([json(401, {error: {code: 'unauthenticated', message: 'Sign in required'}})]);
  await assert.rejects(client(fetch, {onUnauthenticated: () => signedOut++}).get('/api/invoices'), e => e.code === 'unauthenticated');
  assert.equal(signedOut, 1);
});

test('pollInvestigation backs off until a terminal status and reports every update', async () => {
  const states = ['queued', 'in_progress', 'in_progress', 'completed'];
  const {fetch, calls} = stub(states.map(s => json(200, {data: {id: 'i1', investigation_status: s}})));
  const waits = [], seen = [];
  const api = client(fetch, {sleep: async ms => { waits.push(ms); }});
  const done = await api.pollInvestigation('i1', {onUpdate: d => seen.push(d.investigation_status)});
  assert.equal(done.investigation_status, 'completed');
  assert.deepEqual(seen, states);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.url === '/api/investigations/i1' && (c.method ?? 'GET') === 'GET'));
  assert.equal(waits.length, 3);
  assert.ok(waits[0] < waits[2], 'delays grow');
  assert.deepEqual(TERMINAL, ['completed', 'insufficient_evidence', 'failed']);
});

test('pollInvestigation rides out a transient error and stops on failed', async () => {
  const {fetch} = stub([json(200, {data: {id: 'i1', investigation_status: 'queued'}}), new TypeError('blip'), json(200, {data: {id: 'i1', investigation_status: 'failed', error: 'Model timeout'}})]);
  const done = await client(fetch).pollInvestigation('i1');
  assert.equal(done.investigation_status, 'failed');
});

test('pollInvestigation stops when aborted and when the wait budget runs out', async () => {
  const forever = () => json(200, {data: {id: 'i1', investigation_status: 'queued'}});
  const ctrl = new AbortController();
  const {fetch} = stub([forever, forever, forever]);
  let count = 0;
  const last = await client(fetch).pollInvestigation('i1', {signal: ctrl.signal, onUpdate: () => { if (++count === 2) ctrl.abort(); }});
  assert.equal(count, 2);
  assert.equal(last.investigation_status, 'queued');
  const {fetch: f2} = stub(Array(10).fill(forever));
  const timed = await client(f2).pollInvestigation('i1', {maxWaitMs: 2500});
  assert.equal(timed.investigation_status, 'queued');
});

test('loadConfig unwraps the config and falls back to null when the API is unavailable', async () => {
  const dev = {mode: 'dev', dev_users: [{label: 'Riley', token: 't', role: 'reviewer'}]};
  for (const [res, want] of [[json(200, {data: dev}), dev], [json(200, dev), dev], [html(404), null], [new TypeError('offline'), null], [json(200, {data: {mode: 'other'}}), null]]) {
    const {fetch, calls} = stub([res]);
    assert.deepEqual(await client(fetch).loadConfig(), want);
    assert.equal(calls[0].headers.Authorization, undefined);
  }
});
