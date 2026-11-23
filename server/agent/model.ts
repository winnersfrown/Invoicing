// The model boundary: one small interface, the OpenAI implementation (the only import of `openai`), the deterministic
// scripted investigator used by tests, the evaluation harness and the dev server, and the cost estimate table.
import OpenAI from 'openai';
import { z } from 'zod';
import { AgentOutput, type ToolName } from '../contracts/index.ts';
import { readToolResult, type Task } from './prompt.ts';

export type ToolCall = { id: string; name: string; arguments: string };
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type Usage = { input_tokens: number; output_tokens: number };
export type CompleteRequest = { system: string; messages: Message[]; tools: ToolSpec[]; maxOutputTokens: number; signal?: AbortSignal };
export type Completion = { message: string | null; toolCalls: ToolCall[]; usage: Usage };
export interface Model { id: string; complete(req: CompleteRequest): Promise<Completion> }

export const jsonSchemaOf = (s: z.ZodType): Record<string, unknown> => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(s) as Record<string, unknown>;
  return schema;
};

// ---------- cost ----------
// ESTIMATE ONLY: list prices in USD per million tokens as last checked by hand. Verify against the provider before relying on them.
export const PRICE_ESTIMATES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'scripted-investigator': { input: 0, output: 0 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
};
const UNLISTED_MODEL_PRICE = { input: 2, output: 10 }; // deliberately high so an unlisted model is not under-reported
export const estimateCostUsd = (modelId: string, u: Usage) => {
  const p = PRICE_ESTIMATES_USD_PER_MTOK[modelId] ?? UNLISTED_MODEL_PRICE;
  return Math.round((u.input_tokens * p.input + u.output_tokens * p.output) / 1e6 * 1e6) / 1e6;
};

// ---------- OpenAI ----------
/** FALLBACK ONLY, used when OPENAI_MODEL is unset. Set OPENAI_MODEL explicitly in every deployed environment. */
export const FALLBACK_OPENAI_MODEL = 'gpt-5-mini';
const AGENT_OUTPUT_SCHEMA = jsonSchemaOf(AgentOutput);

/**
 * Responses API with function tools and a JSON-schema final answer. `store: false`: invoice data is not kept by the
 * provider. The client is created on first use, so a missing OPENAI_API_KEY fails an investigation, not the API.
 * Schemas are sent with strict: false because the contract schemas use keywords strict mode rejects; the server's
 * Zod validation and verifier are the real gate.
 */
export function openaiModel(id: string, apiKey?: string): Model {
  let client: OpenAI | undefined;
  return {
    id,
    async complete({ system, messages, tools, maxOutputTokens, signal }) {
      client ??= new OpenAI({ apiKey, maxRetries: 1 });
      const input: OpenAI.Responses.ResponseInputItem[] = messages.flatMap((m): OpenAI.Responses.ResponseInputItem[] => {
        if (m.role === 'user') return [{ role: 'user', content: m.content }];
        if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.callId, output: m.content }];
        return [
          ...(m.content ? [{ role: 'assistant' as const, content: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'function_call' as const, call_id: c.id, name: c.name, arguments: c.arguments })),
        ];
      });
      const res = await client.responses.create({
        model: id, instructions: system, input, store: false, max_output_tokens: maxOutputTokens, parallel_tool_calls: true,
        tools: tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        text: { format: { type: 'json_schema', name: 'investigation_result', schema: AGENT_OUTPUT_SCHEMA, strict: false } },
      }, { signal });
      return {
        message: res.output_text || null,
        toolCalls: res.output.flatMap((o) => (o.type === 'function_call' ? [{ id: o.call_id, name: o.name, arguments: o.arguments }] : [])),
        usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
      };
    },
  };
}

// ---------- scripted investigator ----------
export const SCRIPTED_MODEL_ID = 'scripted-investigator';
const PO_TYPES = ['unit_price_mismatch', 'quantity_mismatch', 'unmatched_line', 'tax_mismatch', 'currency_mismatch', 'supplier_mismatch'];
const DOCUMENT_FIELDS = ['supplier_name', 'invoice_number', 'invoice_date', 'due_date', 'po_reference', 'currency', 'subtotal', 'tax_amount', 'total_amount', 'lines'];
const FIELDS_FOR: Record<string, string[]> = {
  ambiguous_reference: ['po_reference'], missing_purchase_order: ['po_reference'], supplier_mismatch: ['supplier_name'], currency_mismatch: ['currency'],
  incorrect_total: ['subtotal', 'tax_amount', 'total_amount', 'lines'], line_arithmetic: ['lines'], tax_mismatch: ['tax_amount', 'lines'],
};
const GENERIC_ACTION: Record<string, AgentOutput['recommended_action']> = {
  incorrect_total: 'request_corrected_invoice', line_arithmetic: 'request_corrected_invoice', tax_mismatch: 'request_corrected_invoice',
  currency_mismatch: 'request_corrected_invoice', supplier_mismatch: 'request_supplier_clarification', unmatched_line: 'request_supplier_clarification',
};
const tokens = (s: string) => Math.ceil(s.length / 4);

/**
 * A deterministic, careful investigator. It reads the task, calls the tools the discrepancy type needs, and composes
 * an AgentOutput only from what the tools returned. It never quotes document text, so nothing in a document can
 * steer it. Its answers are fixed templates per type: good for tests and demos, not a measure of model quality.
 */
export function scriptedModel(): Model {
  return {
    id: SCRIPTED_MODEL_ID,
    async complete({ system, messages, tools }) {
      const input = tokens(system + JSON.stringify(tools) + messages.map((m) => ('content' in m ? m.content ?? '' : '')).join(''));
      const step = decide(messages);
      const out = 'output' in step ? JSON.stringify(step.output) : JSON.stringify(step.calls);
      const toolCalls = 'calls' in step
        ? step.calls.map(([name, args], i) => ({ id: `call_${messages.length}_${i}`, name, arguments: JSON.stringify(args) })) : [];
      return { message: 'output' in step ? out : null, toolCalls, usage: { input_tokens: input, output_tokens: tokens(out) } };
    },
  };
}

type Step = { calls: [ToolName, Record<string, unknown>][] } | { output: AgentOutput };

function decide(messages: Message[]): Step {
  const first = messages[0];
  const t: Task | null = first?.role === 'user' ? JSON.parse(/<task>(.*?)<\/task>/s.exec(first.content)?.[1] ?? 'null') : null;
  if (!t) return { output: insufficient('The task could not be read.', ['The discrepancy to investigate.']) };
  const results = new Map<string, any>();
  const evidence = new Map<string, { id: string; value: string }>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const r = readToolResult(m.content);
    results.set(m.name, r);
    for (const e of r?.ok ? r.evidence : []) evidence.set(e.id, e);
  }
  const want = (calls: [ToolName, Record<string, unknown>][]) => calls.filter(([name]) => !results.has(name));

  let calls = want([['get_discrepancies', { invoice_id: t.invoice_id }], ['get_invoice', { invoice_id: t.invoice_id }]]);
  if (calls.length) return { calls };
  const d = results.get('get_discrepancies')?.data?.find?.((x: any) => x.id === t.discrepancy_id);
  const inv = results.get('get_invoice')?.ok ? results.get('get_invoice').data : null;
  if (!d || !inv) return { output: insufficient('The discrepancy or its invoice could not be retrieved.', ['The discrepancy record and the invoice.']) };

  const poId = d.purchase_order_id ?? inv.purchase_order_id;
  if (PO_TYPES.includes(d.discrepancy_type) && poId) {
    calls = want([['get_purchase_order', { purchase_order_id: poId }], ['compare_invoice_to_po', { invoice_id: inv.id, purchase_order_id: poId }]]);
  } else if (d.discrepancy_type === 'duplicate_candidate') {
    calls = want([['find_duplicate_candidates', { invoice_id: inv.id }]]);
  } else {
    const ev = d.deterministic_evidence ?? {};
    const applicable = { date_order: ['invoice_date', 'due_date'], currency_conversion: ['currency', 'total_amount'], mixed_currency_po: ['currency'] }[ev.check as string];
    const unsure = [...(ev.missing ?? []), ...(ev.uncertain ?? []), ...(ev.unsure_fields ?? []), ...(applicable ?? [])].filter((f: string) => DOCUMENT_FIELDS.includes(f));
    const fields = [...new Set(unsure.length ? unsure : FIELDS_FOR[d.discrepancy_type] ?? ['total_amount'])];
    calls = want([['get_document_evidence', { document_id: inv.id, requested_fields: fields }]]);
  }
  if (calls.length) return { calls };
  return { output: compose(d, inv, results, evidence) };
}

function insufficient(summary: string, missing: string[], hypotheses: string[] = []): AgentOutput {
  return { status: 'insufficient_evidence', summary, findings: [], hypotheses, missing_information: missing, recommended_action: 'insufficient_evidence', confidence: 'low' };
}

function compose(d: any, inv: any, results: Map<string, any>, evidence: Map<string, { id: string }>): AgentOutput {
  const has = (id: string) => evidence.has(id);
  const dId = `discrepancy:${d.id}`;
  const ev = d.deterministic_evidence ?? {};
  const type: string = d.discrepancy_type;

  if (type === 'unit_price_mismatch' || type === 'quantity_mismatch') {
    const il = `invoice_line:${ev.invoice_line_id}`, pl = `po_line:${ev.po_line_id}`;
    const invLine = inv.lines?.find((l: any) => l.id === ev.invoice_line_id);
    const poLine = results.get('get_purchase_order')?.data?.lines?.find((l: any) => l.id === ev.po_line_id);
    if (!has(il) || !has(pl) || !invLine || !poLine) {
      return insufficient('The matched invoice and purchase order lines could not both be retrieved.', ['The invoice line and the purchase order line the engine compared.']);
    }
    const field = type === 'unit_price_mismatch' ? 'unit_price' : 'quantity';
    const [i, p] = field === 'unit_price' ? [moneyCents(invLine.unit_price), moneyCents(poLine.unit_price)] : [invLine.quantity, poLine.quantity];
    if (i === p || results.get('compare_invoice_to_po')?.data?.comparison?.hasDiscrepancy === false) {
      return insufficient('The recorded discrepancy conflicts with the current documents, so no conclusion is drawn.',
        [`The stored ${type.replace(/_/g, ' ')} conflicts with the current invoice and purchase order lines; deterministic validation should be re-run.`]);
    }
    const label = field === 'unit_price' ? 'unit price' : 'quantity';
    const [iv, pv] = [invLine[field], poLine[field]];
    const higher = i > p;
    return {
      status: 'completed',
      summary: `The invoice ${label} ${higher ? 'exceeds' : 'is below'} the purchase order ${label} on line ${invLine.line_number}. The deterministic engine computed the financial difference.`,
      findings: [
        { claim: `The invoice ${label} (${iv}) ${higher ? 'exceeds' : 'is below'} the purchase order ${label} (${pv}) on invoice line ${invLine.line_number}.`, evidence_ids: [il, pl] },
        { claim: `The deterministic engine recorded this ${label} difference as an open discrepancy.`, evidence_ids: [has(dId) ? dId : il] },
      ],
      hypotheses: field === 'unit_price'
        ? ['The supplier may have applied a price change that was not agreed on the purchase order.', 'The purchase order may have been amended without the amendment being recorded.']
        : ['The delivery may have been split or partly back-ordered.', 'The supplier may have invoiced the wrong quantity.'],
      missing_information: field === 'unit_price'
        ? ['Whether an approved purchase order amendment authorises the invoiced price.'] : ['Goods receipt confirming the delivered quantity.'],
      recommended_action: field === 'unit_price' && higher ? 'request_corrected_invoice' : 'request_supplier_clarification',
      confidence: 'high',
    };
  }

  if (type === 'duplicate_candidate') {
    const dup = [...evidence.keys()].find((id) => id.startsWith('duplicate:') && (!ev.other_invoice_id || id.includes(ev.other_invoice_id)));
    if (!dup) return insufficient('The duplicate engine no longer reports this candidate, which conflicts with the recorded discrepancy.', ['A current duplicate comparison for this invoice.']);
    return {
      status: 'completed', summary: 'The duplicate engine matched this invoice with another invoice in the organisation. Both should be compared before either is processed further.',
      findings: [{ claim: 'The duplicate engine reports this invoice as a candidate duplicate of another invoice on file.', evidence_ids: [dup, ...(has(dId) ? [dId] : [])] }],
      hypotheses: ['The supplier may have sent the same invoice twice.', 'The invoice may have been uploaded twice.'],
      missing_information: ['Whether the earlier invoice has already been paid.'], recommended_action: 'investigate_duplicate', confidence: 'medium',
    };
  }

  if (type === 'missing_purchase_order') {
    if (inv.purchase_order_id) return insufficient('A purchase order is now linked. Review the latest validation results.', []);
    return inv.po_reference
      ? insufficient(`The invoice references ${inv.po_reference}. Upload the corresponding purchase order to enable matching.`, ['The purchase order with the reference shown on the invoice.'])
      : insufficient('The invoice has no saved purchase-order reference. Enter it if the invoice lists one.', ['A purchase-order reference from the original document or supplier.']);
  }

  const docs = [...evidence.keys()].filter((id) => id.startsWith('document:'));
  if (!has(dId)) return insufficient('The discrepancy record could not be retrieved.', ['The deterministic discrepancy record.']);

  if (type === 'ambiguous_reference') {
    if ((ev.matches ?? []).length < 2) return insufficient('The recorded ambiguity conflicts with the current purchase orders.', ['The purchase orders matching the reference.']);
    return {
      status: 'completed', summary: 'The invoice purchase order reference matches more than one purchase order on file, so it cannot be matched automatically.',
      findings: [{ claim: `The invoice purchase order reference matches ${ev.matches.length} purchase orders on file.`, evidence_ids: [dId, ...docs] }],
      hypotheses: ['Two purchase orders may have been entered with numbers that differ only in case or spacing.'],
      missing_information: ['Which purchase order the supplier intended.'], recommended_action: 'request_supplier_clarification', confidence: 'medium',
    };
  }

  if (type === 'potential_extraction_error') {
    if (!docs.length) return insufficient('The document evidence for the uncertain fields could not be retrieved.', ['The extracted fields and their source excerpts.']);
    const describe = (fields: string[]) => fields.map(f => f.replaceAll('_', ' ')).join(', ');
    const missing = describe(ev.missing ?? []);
    const uncertain = describe(ev.uncertain ?? ev.unsure_fields ?? []);
    const reason = [missing && `Missing or unreadable fields: ${missing}.`, uncertain && `Fields to confirm: ${uncertain}.`].filter(Boolean).join(' ');
    const claim = typeof d.observed_value === 'string' && ['date_order', 'currency_conversion', 'mixed_currency_po'].includes(ev.check)
      ? d.observed_value : reason || 'The validation check needs a reviewer to verify the cited fields against the original document.';
    const confirmCurrency = !missing && (ev.uncertain?.length === 1 && ev.uncertain[0] === 'currency');
    return {
      status: 'completed', summary: confirmCurrency ? 'Confirm the payable currency shown or intended for this invoice.' : claim,
      findings: [{ claim, evidence_ids: [dId, ...docs] }],
      hypotheses: [],
      missing_information: [confirmCurrency ? 'The payable currency confirmed by the reviewer.' : 'Verification of the flagged fields against the original document.'],
      recommended_action: 'correct_extraction_error', confidence: 'medium',
    };
  }

  return {
    status: 'completed', summary: `The deterministic engine recorded a ${type.replace(/_/g, ' ')} on this invoice. See the cited discrepancy record for the expected and observed values.`,
    findings: [{ claim: `The deterministic engine recorded a ${type.replace(/_/g, ' ')} on this invoice.`, evidence_ids: [dId, ...docs] }],
    hypotheses: [], missing_information: [], recommended_action: GENERIC_ACTION[type] ?? 'escalate_to_reviewer', confidence: 'medium',
  };
}

const moneyCents = (s: string) => Math.round(Number(s) * 100);
