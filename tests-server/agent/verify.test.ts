import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InvestigationResult, type AgentOutput, type EvidenceItem } from '../../server/contracts/index';
import { moneyAmounts, parseAgentOutput, parseWithRepair, verifyOutput, type VerifyContext } from '../../server/agent/verify';

const ids = { inv: randomUUID(), il: randomUUID(), pl: randomUUID(), d: randomUUID(), investigation: randomUUID() };
const item = (id: string, value: string): EvidenceItem => ({ id, label: id.split(':')[0], value });
const evidence = new Map<string, EvidenceItem>([
  item(`invoice_line:${ids.il}`, 'PAPER-A4 A4 copy paper, box: 12 × 45.00 = 540.00'),
  item(`po_line:${ids.pl}`, 'PAPER-A4 A4 copy paper, box: 12 × 40.00 = 480.00'),
  item(`discrepancy:${ids.d}`, 'Expected 40.00; observed 45.00; difference 60.00'),
].map((e) => [e.id, e]));
const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
  investigationId: ids.investigation, invoiceId: ids.inv, currency: 'USD', evidence,
  discrepancy: { id: ids.d, discrepancy_type: 'unit_price_mismatch', difference_amount: '60.00', expected_value: '40.00', observed_value: '45.00' },
  ...over,
});
const good = (over: Partial<AgentOutput> = {}): AgentOutput => ({
  status: 'completed', summary: 'The invoice unit price exceeds the purchase order price.',
  findings: [{ claim: 'The invoice unit price of 45.00 exceeds the PO unit price of 40.00.', evidence_ids: [`invoice_line:${ids.il}`, `po_line:${ids.pl}`] }],
  hypotheses: ['An unrecorded price increase.'], missing_information: [], recommended_action: 'request_corrected_invoice', confidence: 'high', ...over,
});

describe('verifyOutput', () => {
  it('keeps supported findings and takes the financial impact only from the engine', () => {
    const r = verifyOutput(good(), ctx());
    expect(InvestigationResult.parse(r)).toEqual(r);
    expect(r).toMatchObject({ status: 'completed', recommended_action: 'request_corrected_invoice', confidence: 'high', requires_human_approval: true,
      verified_financial_impact: { currency: 'USD', amount: '60.00', source: 'deterministic_engine' } });
    expect(r.evidence.map((e) => e.id)).toEqual([`invoice_line:${ids.il}`, `po_line:${ids.pl}`]);
  });

  it('has no financial impact when the engine produced no amount or currency', () => {
    expect(verifyOutput(good(), ctx({ discrepancy: { ...ctx().discrepancy, difference_amount: null } })).verified_financial_impact).toBeNull();
    expect(verifyOutput(good(), ctx({ currency: null })).verified_financial_impact).toBeNull();
  });

  it('drops a finding citing an invented evidence id and downgrades to insufficient_evidence', () => {
    const r = verifyOutput(good({ findings: [...good().findings, { claim: 'A matching credit note exists.', evidence_ids: [`invoice:${randomUUID()}`] }] }), ctx());
    expect(r.findings).toHaveLength(1);
    expect(r).toMatchObject({ status: 'insufficient_evidence', recommended_action: 'insufficient_evidence', confidence: 'low', requires_human_approval: true });
    expect(r.evidence.every((e) => evidence.has(e.id))).toBe(true);
  });

  it('drops a finding stating an amount that is not in its evidence or the engine figures', () => {
    const r = verifyOutput(good({ findings: [{ claim: 'The supplier overcharged by $75.00.', evidence_ids: [`invoice_line:${ids.il}`] }] }), ctx());
    expect(r.findings).toEqual([]);
    expect(r.status).toBe('insufficient_evidence');
    expect(r.verified_financial_impact?.amount).toBe('60.00');
  });

  it('accepts the engine difference even when the cited lines do not contain it', () => {
    const r = verifyOutput(good({ findings: [{ claim: 'The line is overbilled by USD 60.', evidence_ids: [`invoice_line:${ids.il}`, `po_line:${ids.pl}`] }] }), ctx());
    expect(r.status).toBe('completed');
  });

  it('withholds a summary or hypothesis that invents an amount', () => {
    const r = verifyOutput(good({ summary: 'Total overcharge is $1,250.00.', hypotheses: ['Freight of 99.99 was added.'] }), ctx());
    expect(r.summary).not.toContain('1,250');
    expect(r.possible_causes).toEqual([]);
    expect(r.status).toBe('insufficient_evidence');
  });

  it('a model that says insufficient_evidence cannot also recommend an action, and no findings means insufficient', () => {
    expect(verifyOutput(good({ status: 'insufficient_evidence' }), ctx()).recommended_action).toBe('insufficient_evidence');
    expect(verifyOutput(good({ findings: [] }), ctx())).toMatchObject({ status: 'insufficient_evidence', recommended_action: 'insufficient_evidence' });
  });
});

describe('parseAgentOutput and repair', () => {
  it('rejects an extra amount field (strict schema) and non-JSON', () => {
    expect(parseAgentOutput(JSON.stringify({ ...good(), financial_impact: '75.00' })).ok).toBe(false);
    expect(parseAgentOutput('The invoice looks wrong.').ok).toBe(false);
    expect(parseAgentOutput(null).ok).toBe(false);
    expect(parseAgentOutput('```json\n' + JSON.stringify(good()) + '\n```').ok).toBe(true);
  });

  it('makes exactly one repair attempt', async () => {
    const fixed = vi.fn(async () => JSON.stringify(good()));
    expect((await parseWithRepair(JSON.stringify({ ...good(), amount: '75.00' }), fixed)).ok).toBe(true);
    expect(fixed).toHaveBeenCalledOnce();
    expect(fixed.mock.calls[0]).toEqual([expect.stringContaining('amount')]);
    const still = vi.fn(async () => JSON.stringify({ ...good(), amount: '75.00' }));
    expect((await parseWithRepair('nope', still)).ok).toBe(false);
    expect(still).toHaveBeenCalledOnce();
  });
});

describe('moneyAmounts', () => {
  it('reads currency-marked and two-decimal numbers as cents and ignores plain counts, ids and dates', () => {
    expect(moneyAmounts('12 × 45.00 = 540.00')).toEqual([4500, 54000]);
    expect(moneyAmounts('$1,234.50 and USD 60 and 7 EUR and -60.00')).toEqual([123450, 6000, 700, 6000]);
    expect(moneyAmounts(`12 boxes on 2026-11-01, line 3, id ${randomUUID()}`)).toEqual([]);
  });
});

it('withholds inverted price comparisons and never recommends completing an open discrepancy',()=>{
 const bad=verifyOutput(good({summary:'Invoice is cheaper than the PO.',findings:[{claim:'The invoice price $45.00 is lower than the PO price $40.00.',evidence_ids:[`invoice_line:${ids.il}`,`po_line:${ids.pl}`]}],recommended_action:'approve_review_completion'}),ctx());
 expect(bad.status).toBe('insufficient_evidence');expect(bad.findings).toHaveLength(0);
 expect(verifyOutput(good({recommended_action:'approve_review_completion'}),ctx()).recommended_action).toBe('escalate_to_reviewer');
});
