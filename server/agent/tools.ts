// The agent's nine tools. Each validates its arguments with the contract's Zod schema, calls an existing service with
// the organisation from the job (never from the model), and is logged in tool_calls. Errors go back to the model as data.
import { TOOL_NAMES, ToolInputs, type EvidenceItem, type ToolName, type ToolResult } from '../contracts/index.ts';
import type { Db } from '../db/index.ts';
import { findDuplicateCandidates } from '../services/duplicates.ts';
import { compareInvoiceToPo, draftSupplierMessage } from '../services/matching.ts';
import { getDiscrepancies, getDocumentEvidence, getInvoice, getPurchaseOrder, getResolutionHistory, getSupplier } from '../services/records.ts';
import { ApiError } from '../services/util.ts';
import { jsonSchemaOf, type ToolSpec } from './model.ts';
import { unsupportedAmounts } from './verify.ts';

export type ToolContext = {
  db: Db; orgId: string; investigationId: string; discrepancyId: string; requestedBy: string;
  /** Evidence returned so far in this run, by id. Tools add to it; the verifier reads it. */
  evidence: Map<string, EvidenceItem>;
};
export type ToolOutcome = { ok: true; data: unknown; evidence: EvidenceItem[] } | { ok: false; error: { code: string; message: string } };

class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const DEFS: { [K in ToolName]: { description: string; run: (c: ToolContext, a: any) => Promise<ToolResult> } } = {
  get_invoice: { description: 'Invoice header, line items, status and extraction metadata.', run: (c, a) => getInvoice(c.db, c.orgId, a.invoice_id) },
  get_purchase_order: { description: 'Purchase order header and line items.', run: (c, a) => getPurchaseOrder(c.db, c.orgId, a.purchase_order_id) },
  get_supplier: { description: 'Supplier record on file.', run: (c, a) => getSupplier(c.db, c.orgId, a.supplier_id) },
  get_discrepancies: { description: 'Every discrepancy the deterministic engine recorded for an invoice, with expected and observed values.', run: (c, a) => getDiscrepancies(c.db, c.orgId, a.invoice_id) },
  find_duplicate_candidates: { description: 'Duplicate-engine candidates for an invoice among the organisation\'s other invoices.', run: (c, a) => findDuplicateCandidates(c.db, c.orgId, a.invoice_id) },
  compare_invoice_to_po: { description: 'Deterministic line-by-line comparison of an invoice with a purchase order, including supplier identity.', run: (c, a) => compareInvoiceToPo(c.db, c.orgId, a.invoice_id, a.purchase_order_id) },
  get_document_evidence: {
    description: 'Extracted values, confidence, page and source excerpt for invoice fields. document_id is the invoice id. Fields: supplier_name, invoice_number, invoice_date, due_date, po_reference, currency, subtotal, tax_amount, total_amount, lines.',
    run: (c, a) => getDocumentEvidence(c.db, c.orgId, a.document_id, a.requested_fields),
  },
  get_resolution_history: { description: 'Human decisions on one discrepancy, or recent decisions for a supplier. Give exactly one id.', run: (c, a) => getResolutionHistory(c.db, c.orgId, a) },
  draft_supplier_message: {
    description: 'Stores a draft message to the supplier for the discrepancy under investigation. Never sends it. verified_evidence must be evidence ids from this investigation.',
    async run(c, a) {
      if (a.discrepancy_id !== c.discrepancyId) throw new ToolError('invalid_arguments', 'Drafts can only be made for the discrepancy under investigation.');
      const refs = (a.verified_evidence as string[]).filter((id) => c.evidence.has(id));
      if (!refs.length) throw new ToolError('invalid_arguments', 'verified_evidence must list evidence ids returned by tools in this investigation.');
      if (unsupportedAmounts(a.requested_correction, [...c.evidence.values()].map((e) => e.value)).length) {
        throw new ToolError('invalid_arguments', 'requested_correction states an amount that is not in the evidence.');
      }
      const draft = await draftSupplierMessage(c.db, c.orgId, a.discrepancy_id, {
        actor: { type: 'agent', id: c.investigationId }, createdBy: c.requestedBy, requestedCorrection: a.requested_correction, evidenceReferences: refs });
      return { data: draft, evidence: [] };
    },
  },
};

export const TOOLS: ToolSpec[] = TOOL_NAMES.map((name) => ({ name, description: DEFS[name].description, parameters: jsonSchemaOf(ToolInputs[name]) }));

function failure(e: unknown): ToolOutcome {
  if (e instanceof ToolError) return { ok: false, error: { code: e.code, message: e.message } };
  if (e instanceof ApiError && e.code === 'not_found') return { ok: false, error: { code: 'not_found', message: 'Not found' } };
  if (e instanceof ApiError && e.code === 'conflict') return { ok: false, error: { code: 'conflict', message: e.message } };
  return { ok: false, error: { code: 'tool_failed', message: 'The tool failed. Do not retry it with the same arguments.' } };
}

/** Runs one tool call from the model. Never throws for anything the model sent; always writes a tool_calls row. */
export async function runTool(ctx: ToolContext, name: string, rawArgs: string): Promise<ToolOutcome> {
  const started = Date.now();
  let args: unknown, outcome: ToolOutcome;
  try { args = JSON.parse(rawArgs); } catch { args = { unparsed: String(rawArgs).slice(0, 500) }; }
  const def = (TOOL_NAMES as string[]).includes(name) ? DEFS[name as ToolName] : undefined;
  if (!def) {
    outcome = { ok: false, error: { code: 'unknown_tool', message: `Unknown tool. Available tools: ${TOOL_NAMES.join(', ')}.` } };
  } else {
    const parsed = ToolInputs[name as ToolName].safeParse(args);
    if (!parsed.success) {
      outcome = { ok: false, error: { code: 'invalid_arguments', message: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ')}`.slice(0, 500) } };
    } else {
      try {
        const r = await ctx.db.transaction((tx) => def.run({ ...ctx, db: tx }, parsed.data));
        for (const e of r.evidence) ctx.evidence.set(e.id, e);
        outcome = { ok: true, data: r.data, evidence: r.evidence };
      } catch (e) {
        outcome = failure(e);
      }
    }
  }
  // Postgres text and jsonb reject NUL; the log must never be the thing that fails.
  await ctx.db.query(
    'insert into tool_calls (organization_id, investigation_id, tool_name, arguments, ok, duration_ms) values ($1, $2, $3, $4::jsonb, $5, $6)',
    [ctx.orgId, ctx.investigationId, name.replace(/[^\x20-\x7e]/g, '?').slice(0, 100), (JSON.stringify(args) ?? 'null').replace(/\\u0000/g, ''), outcome.ok, Date.now() - started]);
  return outcome;
}
