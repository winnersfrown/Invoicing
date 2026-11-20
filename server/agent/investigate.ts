// The investigate job: one bounded loop of model turns and tool calls, then the verifier, then one stored result.
// The model recommends; verify.ts decides what survives; a human approves elsewhere. Nothing here edits financial records.
import type { EvidenceItem, InvestigationResult } from '../contracts/index.ts';
import type { Db } from '../db/index.ts';
import { audit } from '../services/audit.ts';
import type { JobHandler } from '../services/jobs.ts';
import { loadDiscrepancy } from '../services/records.ts';
import { estimateCostUsd, type Completion, type Message, type Model, type Usage } from './model.ts';
import { repairMessage, SYSTEM_PROMPT, taskMessage, wrapToolResult } from './prompt.ts';
import { runTool, TOOLS, type ToolContext } from './tools.ts';
import { parseWithRepair, verifyOutput } from './verify.ts';

export type Limits = { maxToolCalls: number; maxIterations: number; maxOutputTokens: number; timeoutMs: number };

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
export const defaultLimits = (): Limits => ({
  maxToolCalls: envInt('AGENT_MAX_TOOL_CALLS', 12),
  maxIterations: envInt('AGENT_MAX_ITERATIONS', 8),
  maxOutputTokens: envInt('AGENT_MAX_OUTPUT_TOKENS', 4000),
  timeoutMs: envInt('AGENT_TIMEOUT_MS', 60_000),
});

/** A failure whose message is safe to store and show. Anything else is stored as a generic message. */
class Stop extends Error {}

export function investigateHandler(o: { model: Model; limits?: Partial<Limits> }): JobHandler {
  return async (db, job) => {
    const limits = { ...defaultLimits(), ...o.limits };
    const orgId = job.organization_id, id: string = job.payload.investigation_id;
    // Claim. A row that is already completed, insufficient_evidence or failed is never re-run: the stored result stands.
    const [inv] = await db.query<{ requested_by: string; discrepancy_id: string }>(
      `update ai_investigations set investigation_status = 'in_progress' where id = $1 and organization_id = $2 and discrepancy_id = $3
         and investigation_status in ('queued', 'in_progress') returning requested_by, discrepancy_id`, [id, orgId, job.payload.discrepancy_id]);
    if (!inv) return;
    await run(db, o.model, limits, orgId, id, inv);
  };
}

async function run(db: Db, model: Model, limits: Limits, orgId: string, id: string, inv: { requested_by: string; discrepancy_id: string }) {
  const started = Date.now();
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let toolCalls = 0;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limits.timeoutMs);
  const timedOut = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(new Stop('The investigation timed out. Retry it.'))));
  timedOut.catch(() => {});
  const usageDto = () => ({ ...usage, tool_calls: toolCalls, estimated_cost_usd: estimateCostUsd(model.id, usage), latency_ms: Date.now() - started });

  try {
    const d = await loadDiscrepancy(db, orgId, inv.discrepancy_id);
    const [invoice] = await db.query<{ currency: string | null; supplier_id: string | null; purchase_order_id: string | null }>(
      'select currency, supplier_id, purchase_order_id from invoices where id = $1 and organization_id = $2', [d.invoice_id, orgId]);
    const ctx: ToolContext = { db, orgId, investigationId: id, discrepancyId: d.id, requestedBy: inv.requested_by, evidence: new Map<string, EvidenceItem>() };
    const messages: Message[] = [{ role: 'user', content: taskMessage({ discrepancy_id: d.id, discrepancy_type: d.discrepancy_type, invoice_id: d.invoice_id,
      purchase_order_id: d.purchase_order_id ?? invoice.purchase_order_id, supplier_id: invoice.supplier_id }) }];
    let iterations = 0;

    const complete = async (): Promise<Completion> => {
      if (++iterations > limits.maxIterations) throw new Stop('Stopped at the iteration limit. Retry the investigation.');
      const c = await Promise.race([model.complete({ system: SYSTEM_PROMPT, messages, tools: TOOLS,
        maxOutputTokens: Math.max(1, limits.maxOutputTokens - usage.output_tokens), signal: ac.signal }), timedOut]);
      usage.input_tokens += c.usage.input_tokens;
      usage.output_tokens += c.usage.output_tokens;
      if (usage.output_tokens > limits.maxOutputTokens) throw new Stop('Stopped at the output token budget. Retry the investigation.');
      return c;
    };

    let c = await complete();
    while (c.toolCalls.length) {
      if (toolCalls + c.toolCalls.length > limits.maxToolCalls) throw new Stop('Stopped at the tool call limit. Retry the investigation.');
      messages.push({ role: 'assistant', content: c.message, toolCalls: c.toolCalls });
      for (const call of c.toolCalls) {
        if (ac.signal.aborted) await timedOut;
        toolCalls++;
        messages.push({ role: 'tool', callId: call.id, name: call.name, content: wrapToolResult(call.name, await runTool(ctx, call.name, call.arguments)) });
      }
      c = await complete();
    }
    const parsed = await parseWithRepair(c.message, async (issues) => {
      messages.push({ role: 'assistant', content: c.message, toolCalls: [] }, { role: 'user', content: repairMessage(issues) });
      return (await complete()).message;
    });
    if (!parsed.ok) throw new Stop('The model answer did not match the required format. Retry the investigation.');
    if (ac.signal.aborted) await timedOut;

    const result: InvestigationResult = verifyOutput(parsed.output, { investigationId: id, invoiceId: d.invoice_id, currency: invoice.currency, discrepancy: d as never, evidence: ctx.evidence });
    await finish(db, model, orgId, id, inv.discrepancy_id, {
      status: result.status, findings: result, evidence_references: result.evidence.map((e) => e.id),
      recommended_action: result.recommended_action, confidence: result.confidence, error: null, usage: usageDto() });
  } catch (e) {
    // Only Stop messages are stored; provider and database errors can carry keys, ids or internals.
    const error = e instanceof Stop ? e.message : 'The investigation failed. Retry it.';
    await finish(db, model, orgId, id, inv.discrepancy_id, {
      status: 'failed', findings: null, evidence_references: [], recommended_action: null, confidence: null, error, usage: usageDto() });
  } finally {
    clearTimeout(timer);
  }
}

async function finish(db: Db, model: Model, orgId: string, id: string, discrepancyId: string, r: {
  status: string; findings: InvestigationResult | null; evidence_references: string[]; recommended_action: string | null;
  confidence: string | null; error: string | null; usage: Record<string, number>;
}) {
  await db.transaction(async (tx) => {
    await tx.query(
      `update ai_investigations set investigation_status = $3, findings = $4::jsonb, evidence_references = $5::jsonb, recommended_action = $6,
         confidence = $7, error = $8, usage = $9::jsonb, model_identifier = $10, completed_at = now() where id = $1 and organization_id = $2`,
      [id, orgId, r.status, r.findings && JSON.stringify(r.findings), JSON.stringify(r.evidence_references), r.recommended_action,
        r.confidence, r.error, JSON.stringify(r.usage), model.id]);
    await audit(tx, { orgId, actor: { type: 'agent', id: model.id }, event: `investigation.${r.status}`, targetType: 'ai_investigation', targetId: id,
      previous: { investigation_status: 'in_progress' },
      next: { investigation_status: r.status, discrepancy_id: discrepancyId, recommended_action: r.recommended_action, confidence: r.confidence, error: r.error } });
  });
}
