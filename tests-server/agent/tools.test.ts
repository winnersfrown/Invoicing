import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES, type EvidenceItem } from '../../server/contracts/index';
import { scriptedModel } from '../../server/agent/model';
import { runTool, TOOLS, type ToolContext } from '../../server/agent/tools';
import { agentEnv, type AgentEnv } from './env';

let env: AgentEnv;
let a: Awaited<ReturnType<AgentEnv['newOrg']>>, b: typeof a;
let A: Awaited<ReturnType<AgentEnv['scenario']>>, B: typeof A;
let ctx: ToolContext;

beforeAll(async () => {
  env = await agentEnv(scriptedModel());
  [a, b] = [await env.newOrg('A'), await env.newOrg('B')];
  [A, B] = [await env.scenario(a), await env.scenario(b)];
  const r = await env.http('POST', `/api/discrepancies/${A.discrepancies[0].id}/investigate`, a.reviewer);
  ctx = { db: env.db, orgId: a.id, investigationId: r.body.data.id, discrepancyId: A.discrepancies[0].id, requestedBy: a.reviewer, evidence: new Map<string, EvidenceItem>() };
});
afterAll(async () => env.close());

const logged = async () => env.db.query<{ tool_name: string; arguments: any; ok: boolean; duration_ms: number }>(
  'select tool_name, arguments, ok, duration_ms from tool_calls where investigation_id = $1 order by created_at, id', [ctx.investigationId]);
const lastLog = async () => (await logged()).at(-1)!;

describe('tool registry', () => {
  it('has exactly the nine contract tools, each with an object JSON schema', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(TOOLS).toHaveLength(9);
    for (const t of TOOLS) {
      expect(t.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('no tool accepts SQL, a URL, a path, a command or an organisation', () => {
    const props = TOOLS.flatMap((t) => Object.keys((t.parameters as { properties: object }).properties));
    expect(props.filter((p) => /sql|query|url|path|command|org/i.test(p))).toEqual([]);
  });
});

describe('runTool', () => {
  it('returns data and evidence, records the call and remembers evidence ids', async () => {
    const r = await runTool(ctx, 'get_invoice', JSON.stringify({ invoice_id: A.invoiceId }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.evidence.map((e) => e.id)).toContain(`invoice:${A.invoiceId}`);
    expect(ctx.evidence.has(`invoice:${A.invoiceId}`)).toBe(true);
    expect(await lastLog()).toMatchObject({ tool_name: 'get_invoice', arguments: { invoice_id: A.invoiceId }, ok: true, duration_ms: expect.any(Number) });
  });

  it('another organisation\'s ids are not_found, exactly like missing ones', async () => {
    const foreign = await runTool(ctx, 'get_invoice', JSON.stringify({ invoice_id: B.invoiceId }));
    const missing = await runTool(ctx, 'get_invoice', JSON.stringify({ invoice_id: randomUUID() }));
    expect(foreign).toEqual({ ok: false, error: { code: 'not_found', message: 'Not found' } });
    expect(missing).toEqual(foreign);
    expect(await lastLog()).toMatchObject({ ok: false });
    expect(ctx.evidence.has(`invoice:${B.invoiceId}`)).toBe(false);
  });

  it.each([
    ['a bad uuid', 'get_invoice', { invoice_id: 'not-a-uuid' }],
    ['an organisation override', 'get_invoice', { invoice_id: randomUUID(), organization_id: randomUUID() }],
    ['both history keys', 'get_resolution_history', { discrepancy_id: randomUUID(), supplier_id: randomUUID() }],
    ['malformed JSON', 'get_invoice', '{"invoice_id":'],
  ])('rejects %s as invalid_arguments and logs it', async (_label, name, args) => {
    const r = await runTool(ctx, name, typeof args === 'string' ? args : JSON.stringify(args));
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(await lastLog()).toMatchObject({ tool_name: name, ok: false });
  });

  it.each(['approve_invoice', 'resolve_discrepancy', 'run_sql', 'toString', '__proto__'])('rejects unknown tool %s and logs it', async (name) => {
    const r = await runTool(ctx, name, '{}');
    expect(r).toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    expect(await lastLog()).toMatchObject({ tool_name: name, ok: false });
  });

  it('draft_supplier_message only stores a draft, for this discrepancy, citing evidence from this run', async () => {
    const before = await env.snapshot(a.id);
    const ok = await runTool(ctx, 'draft_supplier_message', JSON.stringify({
      discrepancy_id: ctx.discrepancyId, verified_evidence: [`invoice:${A.invoiceId}`, 'invoice:made-up'], requested_correction: 'Please reissue the invoice at the agreed PO price.' }));
    expect(ok).toMatchObject({ ok: true, data: { sent: false, discrepancy_id: ctx.discrepancyId } });
    if (ok.ok) expect((ok.data as { evidence_references: string[] }).evidence_references).not.toContain('invoice:made-up');
    expect(await env.snapshot(a.id)).toEqual(before);
    const drafts = await env.db.query('select count(*)::int as n from supplier_message_drafts where organization_id = $1', [a.id]);
    expect(drafts[0].n).toBe(1);
    const [ev] = await env.db.query(`select actor_type from audit_events where event_type = 'supplier_message.drafted' and organization_id = $1`, [a.id]);
    expect(ev.actor_type).toBe('agent');

    const other = await runTool(ctx, 'draft_supplier_message', JSON.stringify({ discrepancy_id: B.discrepancies[0].id, verified_evidence: [`invoice:${A.invoiceId}`], requested_correction: 'x' }));
    expect(other).toMatchObject({ ok: false });
    const unverified = await runTool(ctx, 'draft_supplier_message', JSON.stringify({ discrepancy_id: ctx.discrepancyId, verified_evidence: ['invoice:made-up'], requested_correction: 'x' }));
    expect(unverified).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    const invented = await runTool(ctx, 'draft_supplier_message', JSON.stringify({ discrepancy_id: ctx.discrepancyId, verified_evidence: [`invoice:${A.invoiceId}`], requested_correction: 'Refund $900.00 now.' }));
    expect(invented).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect((await env.db.query('select count(*)::int as n from supplier_message_drafts where organization_id = $1', [a.id]))[0].n).toBe(1);
  });
});
