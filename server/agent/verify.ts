// Turns the model's AgentOutput into the stored InvestigationResult. The model recommends; this file decides what survives.
import type { z } from 'zod';
import { AgentOutput, MoneyString, SCHEMA_VERSION, type DiscrepancyType, type EvidenceItem, type InvestigationResult } from '../contracts/index';

export type Parsed = { ok: true; output: AgentOutput } | { ok: false; issues: string };

export function parseAgentOutput(text: string | null | undefined): Parsed {
  if (!text?.trim()) return { ok: false, issues: 'No final answer was given.' };
  let json: unknown;
  try { json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { ok: false, issues: 'The final answer was not valid JSON.' }; }
  const p = AgentOutput.safeParse(json);
  return p.success ? { ok: true, output: p.data }
    : { ok: false, issues: p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ').slice(0, 1000) };
}

/** Parses; on failure asks `repair` once (with the validation issues) and parses that. A second failure is final. */
export async function parseWithRepair(text: string | null, repair: (issues: string) => Promise<string | null>): Promise<Parsed> {
  const first = parseAgentOutput(text);
  return first.ok ? first : parseAgentOutput(await repair(first.issues));
}

/**
 * Money amounts in text, as absolute integer cents: numbers with a currency mark ($, €, £, USD, EUR, GBP, dollars)
 * or exactly two decimals. Plain counts, dates and ids are ignored.
 * ponytail: regex heuristic. Misses amounts in words ("sixty dollars") and other currency codes; treats any
 * two-decimal number (a 12.50% rate) as money, which only ever errs towards dropping a finding.
 */
export function moneyAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g)) {
    const end = m.index + m[0].length;
    if (/\d$/.test(text.slice(0, m.index)) || /^\.\d/.test(text.slice(end))) continue; // part of a longer token
    const marked = /(?:[$€£]|\b(?:USD|EUR|GBP))\s?$/i.test(text.slice(Math.max(0, m.index - 4), m.index))
      || /^\s?(?:USD|EUR|GBP|dollars?)\b/i.test(text.slice(end, end + 9));
    if (!marked && m[2]?.length !== 3) continue;
    out.push(Math.round(Number(`${m[1].replace(/,/g, '')}${m[2] ?? ''}`) * 100));
  }
  return out;
}

/** Amounts stated in `text` that appear in none of `sources`. */
export function unsupportedAmounts(text: string, sources: string[]): number[] {
  const allowed = new Set(sources.flatMap(moneyAmounts));
  return moneyAmounts(text).filter((a) => !allowed.has(a));
}

export type VerifyContext = {
  investigationId: string; invoiceId: string; currency: string | null;
  discrepancy: { id: string; discrepancy_type: z.infer<typeof DiscrepancyType>; difference_amount: string | null; expected_value: string | null; observed_value: string | null };
  /** Every evidence item returned by a tool in this run, by id. */
  evidence: Map<string, EvidenceItem>;
};

const WITHHELD_SUMMARY = 'The model summary was withheld because it stated an amount that is not in the evidence. See the findings and the engine figures.';
const DROPPED_NOTE = 'Some model statements were removed because they cited evidence not returned in this investigation or stated amounts not in the evidence.';

// Narrow deterministic direction checks; broader natural-language entailment is not claimed.
export function contradictsDirection(text: string, expected: string | null, observed: string | null): boolean {
 const numeric=(v:string|null)=>v!=null&&/^-?\d+(?:\.\d+)?$/.test(v)?Number(v):null;
 const e=numeric(expected),o=numeric(observed);if(e==null||o==null||e===o)return false;
 const lower=/\b(lower than|below|less than|cheaper than)\b/i, higher=/\b(higher than|exceeds?|above|greater than|more than)\b/i;
 // Only invoice -> purchase-order assertions: reverse-direction assertions require manual review.
 if(!/invoice/i.test(text)||!/(?:PO\b|purchase order)/i.test(text))return false;
 const invoiceFirst=text.search(/invoice/i)<text.search(/\bPO\b|purchase order/i);
 return invoiceFirst ? (o>e?lower.test(text):higher.test(text)) : (o>e?higher.test(text):lower.test(text));
}
export function verifyOutput(out: AgentOutput, ctx: VerifyContext): InvestigationResult {
  const d = ctx.discrepancy;
  const engine = [d.difference_amount, d.expected_value, d.observed_value].filter((x): x is string => !!x);
  const everything = [...[...ctx.evidence.values()].map((e) => e.value), ...engine];
  let dropped = 0;
  const keep = <T>(xs: T[], ok: (x: T) => boolean) => xs.filter((x) => (ok(x) ? true : (dropped++, false)));

  // A finding survives only if every id it cites came from a tool in this run and every amount it states is in those items or the engine's figures.
  const findings = keep(out.findings, (f) => f.evidence_ids.every((id) => ctx.evidence.has(id))
    && !contradictsDirection(f.claim,d.expected_value,d.observed_value)
    && !unsupportedAmounts(f.claim, [...f.evidence_ids.map((id) => ctx.evidence.get(id)!.value), ...engine]).length);
  const possible_causes = keep(out.hypotheses, (h) => !unsupportedAmounts(h, everything).length);
  const missing = keep(out.missing_information, (m) => !unsupportedAmounts(m, everything).length);
  const summaryOk = !unsupportedAmounts(out.summary, everything).length && !contradictsDirection(out.summary,d.expected_value,d.observed_value);
  if (!summaryOk) dropped++;

  const insufficient = dropped > 0 || !findings.length || out.status === 'insufficient_evidence' || out.recommended_action === 'insufficient_evidence';
  const amount = d.difference_amount != null && MoneyString.safeParse(d.difference_amount).success ? d.difference_amount : null;
  const currency = ctx.currency && /^[A-Z]{3}$/.test(ctx.currency) ? ctx.currency : null;
  return {
    schema_version: SCHEMA_VERSION,
    investigation_id: ctx.investigationId, invoice_id: ctx.invoiceId, discrepancy_id: d.id, discrepancy_type: d.discrepancy_type,
    status: insufficient ? 'insufficient_evidence' : 'completed',
    summary: summaryOk ? out.summary : WITHHELD_SUMMARY,
    findings, possible_causes,
    missing_information: dropped ? [...missing, DROPPED_NOTE] : missing,
    evidence: [...new Set(findings.flatMap((f) => f.evidence_ids))].map((id) => ctx.evidence.get(id)!),
    verified_financial_impact: amount && currency ? { currency, amount, source: 'deterministic_engine' } : null,
    recommended_action: insufficient ? 'insufficient_evidence' : out.recommended_action==='approve_review_completion'?'escalate_to_reviewer':out.recommended_action,
    confidence: dropped ? 'low' : out.confidence,
    requires_human_approval: true,
  };
}
