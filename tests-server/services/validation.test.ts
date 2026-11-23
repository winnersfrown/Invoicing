import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiscrepancyDto, InvoiceDto } from '../../server/contracts/index';
import { invoiceBody, poBody, setup, type Env } from '../api/helpers';

let env: Env;
beforeAll(async () => { env = await setup(); });
afterAll(async () => env.close());

async function orgWithPo(po = poBody()) {
  const org = await env.newOrg();
  const r = await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: po });
  expect(r.status).toBe(201);
  return org;
}
async function upload(org: { reviewer: string }, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const r = await env.call('POST', '/api/invoices', { user: org.reviewer, body: invoiceBody(over, extra) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return InvoiceDto.parse(r.body.data);
}
async function discrepancies(org: { viewer: string }, invoiceId: string) {
  const r = await env.call('GET', `/api/invoices/${invoiceId}/discrepancies`, { user: org.viewer });
  expect(r.status).toBe(200);
  return DiscrepancyDto.array().parse(r.body.data);
}
const clean = { subtotal: '480.00', total_amount: '480.00',
  lines: [{ sku: 'WID-1', description: 'Widget', quantity: 12, unit_price: '40.00', line_total: '480.00', tax_amount: null }] };

describe('required scenario: price mismatch, then corrected invoice supersedes it', () => {
  it('flags one unit_price_mismatch of 60.00 from the engine, then validates the correction', async () => {
    const org = await orgWithPo();
    const original = await upload(org);
    expect(original.status).toBe('exception');
    const ds = await discrepancies(org, original.id);
    expect(ds).toHaveLength(1);
    const [d] = ds;
    expect(d.discrepancy_type).toBe('unit_price_mismatch');
    expect(d.difference_amount).toBe('60.00');
    expect(d.expected_value).toBe('40.00');
    expect(d.observed_value).toBe('45.00');
    const ev = d.deterministic_evidence as any;
    expect(ev.engine).toBe('compareDocuments');
    expect(ev.line.differenceCents).toBe(6000);

    const corrected = await upload(org, { invoice_number: 'INV-2001-C', ...clean }, { supersedes_invoice_id: original.id });
    expect(corrected.status).toBe('validated');
    expect(corrected.supersedes_invoice_id).toBe(original.id);
    expect(await discrepancies(org, corrected.id)).toHaveLength(0);

    const again = await env.call('GET', `/api/invoices/${original.id}`, { user: org.viewer });
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('superseded');
    expect(again.body.data.document_url).toMatch(/^https:\/\//);
    expect((await env.call('GET', `/api/invoices/${corrected.id}`, { user: org.viewer })).body.data.total_amount).toBe('480.00');

    const audit = await env.db.query<{ event_type: string; target_id: string; previous_state: any; new_state: any }>(
      'select event_type, target_id, previous_state, new_state from audit_events where organization_id = $1 order by id', [org.id]);
    const trail = audit.filter((a) => [original.id, corrected.id].includes(a.target_id) && a.event_type !== 'invoice.linked')
      .map((a) => `${a.target_id === original.id ? 'orig' : 'corr'}:${a.event_type}:${a.previous_state?.status ?? ''}>${a.new_state?.status ?? ''}`);
    expect(trail).toEqual([
      'orig:invoice.created:>uploaded',
      'orig:invoice.status_changed:uploaded>exception',
      'orig:invoice.status_changed:exception>superseded',
      'corr:invoice.created:>uploaded',
      'corr:invoice.status_changed:uploaded>validated',
    ]);
    expect(audit.some((a) => a.event_type === 'discrepancy.created' && a.target_id === d.id)).toBe(true);
  });
});

describe('deterministic checks', () => {
  it('correct totals validate with no discrepancies', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, clean);
    expect(inv.status).toBe('validated');
    expect(inv.purchase_order_id).not.toBeNull();
    expect(inv.supplier_id).not.toBeNull();
    expect(await discrepancies(org, inv.id)).toHaveLength(0);
  });

  it('incorrect total is flagged with the integer-cents difference', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, total_amount: '500.00' });
    expect(inv.status).toBe('exception');
    const ds = await discrepancies(org, inv.id);
    const t = ds.find((d) => d.discrepancy_type === 'incorrect_total')!;
    expect(t).toBeDefined();
    expect(t).toMatchObject({ expected_value: '480.00', observed_value: '500.00', difference_amount: '20.00', severity: 'high' });
  });

  it('line arithmetic mismatch is flagged per line', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, lines: [{ ...clean.lines[0], line_total: '490.00' }], subtotal: '490.00', total_amount: '490.00' });
    const t = (await discrepancies(org, inv.id)).find((d) => d.discrepancy_type === 'line_arithmetic')!;
    expect(t).toMatchObject({ expected_value: '480.00', observed_value: '490.00', difference_amount: '10.00' });
  });

  it('duplicate reference from the same supplier is a duplicate candidate', async () => {
    const org = await orgWithPo();
    const first = await upload(org, clean);
    const second = await upload(org, { ...clean, source_text: 'Second delivery note' });
    const d = (await discrepancies(org, second.id)).find((x) => x.discrepancy_type === 'duplicate_candidate')!;
    expect(d).toBeDefined();
    expect((d.deterministic_evidence as any).other_invoice_id).toBe(first.id);
    expect((d.deterministic_evidence as any).level).toBe('Strong field match');
    const dup = await env.call('GET', `/api/invoices/${second.id}/duplicate-candidates`, { user: org.viewer });
    expect(dup.body.data.candidates[0].other_invoice_id).toBe(first.id);
    expect(dup.body.data.evidence[0].id).toMatch(/^duplicate:/);
  });

  it('altered invoice number with a reissue label is a duplicate candidate', async () => {
    const org = await orgWithPo();
    await upload(org, { ...clean, invoice_number: '9320' });
    const reissued = await upload(org, { ...clean, invoice_number: 'REISSUED-9320' });
    const d = (await discrepancies(org, reissued.id)).find((x) => x.discrepancy_type === 'duplicate_candidate')!;
    expect(d).toBeDefined();
    expect((d.deterministic_evidence as any).evidence.join(' ')).toMatch(/delivery label/);
  });

  it('an unrelated reference from the same supplier is not a duplicate', async () => {
    const org = await orgWithPo();
    await upload(org, { ...clean, invoice_number: '9320' });
    const other = await upload(org, { ...clean, invoice_number: '9321', source_text: 'A different short note' });
    expect((await discrepancies(org, other.id)).map((d) => d.discrepancy_type)).not.toContain('duplicate_candidate');
  });

  it('supplier mismatch against the PO is flagged and line comparison is skipped', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, supplier_name: 'Southwind Traders' });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map((d) => d.discrepancy_type)).toEqual(['supplier_mismatch']);
    expect(ds[0]).toMatchObject({ severity: 'high', expected_value: 'Northwind Supplies LLC', observed_value: 'Southwind Traders' });
  });

  it('a near-identical supplier name needs identity review but lines are still compared', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, supplier_name: 'Northwind Suplies LLC' });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map((d) => d.discrepancy_type)).toEqual(['supplier_mismatch']);
    expect(ds[0].severity).toBe('medium');
  });

  it('quantity difference is flagged with the engine line difference', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { subtotal: '400.00', total_amount: '400.00',
      lines: [{ sku: 'WID-1', description: 'Widget', quantity: 10, unit_price: '40.00', line_total: '400.00', tax_amount: null }] });
    const ds = await discrepancies(org, inv.id);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ discrepancy_type: 'quantity_mismatch', expected_value: '12', observed_value: '10', difference_amount: '-80.00' });
  });

  it('tax difference against the PO is flagged', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, tax_amount: '20.00', total_amount: '500.00' });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map((d) => [d.discrepancy_type, d.difference_amount])).toEqual([['tax_mismatch', '20.00']]);
  });

  it('missing PO reference is flagged', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, po_reference: null });
    expect(inv.status).toBe('exception');
    expect((await discrepancies(org, inv.id)).map((d) => d.discrepancy_type)).toEqual(['missing_purchase_order']);
  });

  it('a PO reference with no PO on file is flagged as missing PO, and a later PO triggers reprocessing', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, po_reference: 'PO-7777' });
    expect((await discrepancies(org, inv.id)).map((d) => [d.discrepancy_type, d.observed_value])).toEqual([['missing_purchase_order', 'PO-7777']]);
    expect((await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody({ purchase_order_number: 'PO-7777' }) })).status).toBe(201);
    const jobs = await env.db.query<{ kind: string; payload: any }>('select kind, payload from jobs where organization_id = $1', [org.id]);
    expect(jobs).toEqual([{ kind: 'process_invoice', payload: { invoice_id: inv.id } }]);
  });

  it('separates a missing PO record from extraction even for an unregistered supplier', async () => {
    const org = await env.newOrg();
    const inv = await upload(org, { ...clean, supplier_name: 'Juliana Silva', po_reference: 'PO-2025-042', extraction: {
      method: 'ocr', confidence: 0.5, field_confidence: { currency: 0.5 }, uncertain: ['currency'], reviewed_fields: ['currency'],
    } });
    const findings = await discrepancies(org, inv.id);
    expect(findings.map(d => d.discrepancy_type)).toEqual(['missing_purchase_order']);
    expect(findings[0].deterministic_evidence).toMatchObject({check: 'po_lookup', po_reference: 'PO-2025-042'});
  });

  it('corrects a legacy supplier and confirms currency without a re-upload or a repeated warning', async () => {
    const org = await env.newOrg();
    const inv = await upload(org, { ...clean, supplier_name: '(on file):', po_reference: 'PO-2025-042', extraction: {
      method: 'ocr', confidence: 0.5, field_confidence: {currency: 0.5}, uncertain: ['currency'],
    } });
    const path = `/api/invoices/${inv.id}`;
    const body = {updated_at: inv.updated_at, values: {supplier_name: 'Juliana Silva', currency: 'usd'}};
    const saved = await env.call('POST', `${path}/review-fields`, {user: org.reviewer, body});
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({id: inv.id, supplier_name: 'Juliana Silva', currency: 'USD', status: 'exception', open_discrepancy_count: 1});
    expect(saved.body.data.extraction.reviewed_fields).toEqual(expect.arrayContaining(['supplier_name', 'currency']));
    expect((await env.call('POST', `${path}/process`, {user: org.reviewer})).status).toBe(200);
    expect((await discrepancies(org, inv.id)).map(d => [d.discrepancy_type, d.status]).sort()).toEqual([
      ['missing_purchase_order', 'open'], ['potential_extraction_error', 'dismissed'],
    ]);
    expect((await env.call('POST', `${path}/review-fields`, {user: org.reviewer, body})).status).toBe(409);
  });

  it('shows a missing reference once even when the extractor also reports it missing', async () => {
    const org = await env.newOrg();
    const inv = await upload(org, { ...clean, po_reference: null, tax_amount: null, extraction: {
      method: 'ocr', confidence: 0.8, missing: ['po_reference', 'tax_amount'],
    } });
    const findings = await discrepancies(org, inv.id);
    expect(findings.map(d => d.discrepancy_type)).toEqual(['missing_purchase_order']);
    expect(findings[0].deterministic_evidence).toMatchObject({check: 'po_reference', po_reference: null});
  });

  it('currency mismatch is flagged instead of the engine throwing', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, currency: 'EUR' });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map((d) => d.discrepancy_type)).toEqual(['currency_mismatch']);
    expect(ds[0]).toMatchObject({ expected_value: 'USD', observed_value: 'EUR' });
  });

  it('matches EUR documents and stores a normalized currency code', async () => {
    const org = await orgWithPo(poBody({ currency: 'eur' }));
    const inv = await upload(org, { ...clean, currency: 'EUR' });
    expect(inv).toMatchObject({ currency: 'EUR', status: 'validated' });
    expect(await discrepancies(org, inv.id)).toHaveLength(0);
  });

  it('leaves missing tax unknown and requests review instead of reporting false differences', async () => {
    const org = await orgWithPo(poBody({ tax_amount: '20.00', total_amount: '500.00' }));
    const inv = await upload(org, { ...clean, tax_amount: null, total_amount: '500.00' });
    expect(inv).toMatchObject({ tax_amount: null, status: 'needs_extraction_review' });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map(d => d.discrepancy_type)).toEqual(['potential_extraction_error']);
    expect(ds[0].deterministic_evidence).toMatchObject({ check: 'financial_inputs', missing: ['tax_amount'] });
    expect(ds[0].difference_amount).toBeNull();
  });

  it('does not add incomplete line taxes or substitute zero for an unreadable charge', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, {
      ...clean, po_reference: null, tax_amount: '20.00', total_amount: '510.00',
      lines: [{ ...clean.lines[0], quantity: 6, line_total: '240.00', tax_amount: '10.00' },
        { ...clean.lines[0], sku: 'WID-2', quantity: 6, line_total: '240.00' }],
      extraction: { method: 'manual', confidence: null, support_labels: {
        adjustments: { reviewedValue: [{ kind: 'freight', cents: null, appliesTo: 'total' }] },
      } },
    });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map(d => d.discrepancy_type).sort()).toEqual(['missing_purchase_order', 'potential_extraction_error']);
    expect(ds.find(d => d.discrepancy_type === 'potential_extraction_error')?.deterministic_evidence)
      .toMatchObject({ check: 'financial_inputs', missing: ['adjustments'] });
  });

  const dualExtraction = { method: 'manual', confidence: null, support_labels: {
    pricingCurrency: { reviewedValue: 'EUR' },
    pricingTotal: { reviewedValue: '480.00' },
    exchangeRate: { reviewedValue: { base: 'EUR', quote: 'USD', rate: 1.2, decimals: 4 } },
  } };

  it('keeps a mixed-currency invoice out of direct PO comparisons even with the same payable currency', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, total_amount: '576.00', extraction: dualExtraction });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map(d => d.discrepancy_type)).toEqual(['potential_extraction_error']);
    expect(ds[0].deterministic_evidence).toMatchObject({ check: 'mixed_currency_po', pricing_currency: 'EUR', invoice_currency: 'USD' });
    expect(ds[0].difference_amount).toBeNull();
  });

  it('flags a printed conversion that disagrees beyond the exchange-rate rounding tolerance', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { ...clean, total_amount: '586.00', extraction: dualExtraction });
    const ds = await discrepancies(org, inv.id);
    expect(ds.find(d => (d.deterministic_evidence as any).check === 'currency_conversion')).toMatchObject({
      discrepancy_type: 'incorrect_total', expected_value: '576.00', difference_amount: '10.00',
      deterministic_evidence: { currency: 'USD', pricing_currency: 'EUR' },
    });
  });

  it('labels internal mixed-currency arithmetic findings in the pricing currency', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, {
      ...clean, total_amount: '588.00', extraction: { ...dualExtraction, support_labels: {
        ...dualExtraction.support_labels, pricingTotal: { reviewedValue: '490.00' },
      } },
    });
    const ds = await discrepancies(org, inv.id);
    expect(ds.find(d => (d.deterministic_evidence as any).check === 'total')).toMatchObject({
      discrepancy_type: 'incorrect_total', expected_value: '480.00', difference_amount: '10.00',
      deterministic_evidence: { currency: 'EUR' },
    });
    expect(ds.some(d => (d.deterministic_evidence as any).check === 'currency_conversion')).toBe(false);
  });

  it('a missing extracted field needs extraction review, not a real discrepancy', async () => {
    const org = await orgWithPo();
    const ex = { method: 'ocr', confidence: 0.6, field_confidence: {}, missing: ['total_amount'], uncertain: [], source_refs: {} };
    const inv = await upload(org, { ...clean, total_amount: null, extraction: ex });
    expect(inv.status).toBe('needs_extraction_review');
    const ds = await discrepancies(org, inv.id);
    expect(ds.map((d) => d.discrepancy_type)).toEqual(['potential_extraction_error']);
    expect((ds[0].deterministic_evidence as any).missing).toEqual(['total_amount']);
  });

  it('an arithmetic failure on an uncertain field is classified as a potential extraction error', async () => {
    const org = await orgWithPo();
    const ex = { method: 'ocr', confidence: 0.7, field_confidence: { total_amount: 0.41 }, missing: [], uncertain: [], source_refs: {} };
    const inv = await upload(org, { ...clean, total_amount: '430.00', extraction: ex });
    expect(inv.status).toBe('needs_extraction_review');
    const types = (await discrepancies(org, inv.id)).map((d) => [d.discrepancy_type, (d.deterministic_evidence as any).suspected_type ?? null]);
    expect(types).toContainEqual(['potential_extraction_error', 'incorrect_total']);
    expect(types.map((t) => t[0])).not.toContain('incorrect_total');
  });

  it('a shape the engine rejects (fractional quantity) becomes a classified discrepancy, not a 500', async () => {
    const org = await orgWithPo();
    const inv = await upload(org, { subtotal: '500.00', total_amount: '500.00',
      lines: [{ sku: 'WID-1', description: 'Widget', quantity: 12.5, unit_price: '40.00', line_total: '500.00', tax_amount: null }] });
    const ds = await discrepancies(org, inv.id);
    expect(ds.map((d) => d.discrepancy_type)).toEqual(['unmatched_line']);
    expect((ds[0].deterministic_evidence as any).engine_error).toMatch(/whole-number/);
  });

  it('re-running validation on unchanged data creates no duplicates', async () => {
    const org = await orgWithPo();
    const inv = await upload(org);
    const before = await discrepancies(org, inv.id);
    const r = await env.call('POST', `/api/invoices/${inv.id}/process`, { user: org.reviewer });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('exception');
    const after = await discrepancies(org, inv.id);
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    const [row] = await env.db.query<{ evidence_hash: string }>('select evidence_hash from discrepancies where id = $1', [after[0].id]);
    expect(row.evidence_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('PO creation rejects documents the engine rejects', async () => {
    const org = await env.newOrg();
    const r = await env.call('POST', '/api/purchase-orders', { user: org.reviewer, body: poBody({ total_amount: '481.00' }) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_request');
  });
});
