import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoiceBody, poBody, setup, type Env } from '../api/helpers';

let env: Env;
beforeAll(async () => { env = await setup(); });
afterAll(async () => env.close());

const clean = { subtotal: '480.00', total_amount: '480.00',
  lines: [{ sku: 'WID-1', description: 'Widget', quantity: 12, unit_price: '40.00', line_total: '480.00', tax_amount: null }] };
const unsureCurrency = { method: 'ocr', confidence: 0.5, field_confidence: { currency: 0.5 }, uncertain: ['currency'], source_refs: {} };

async function org(po = true) {
  const o = await env.newOrg();
  if (po) expect((await env.call('POST', '/api/purchase-orders', { user: o.reviewer, body: poBody() })).status).toBe(201);
  return o;
}
async function upload(o: { reviewer: string }, over: Record<string, unknown> = {}) {
  const r = await env.call('POST', '/api/invoices', { user: o.reviewer, body: invoiceBody(over) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data;
}
const findings = async (o: { viewer: string }, id: string) => (await env.call('GET', `/api/invoices/${id}/discrepancies`, { user: o.viewer })).body.data as any[];
const resolve = (o: { reviewer: string }, id: string, body: Record<string, unknown>) => env.call('POST', `/api/discrepancies/${id}/resolve`, { user: o.reviewer, body });

describe('decisions say what is still required', () => {
  it('approving a field correction is not resolving: next step is correct_field, repeats are blocked, and the correction closes it', async () => {
    const o = await org();
    const inv = await upload(o, { ...clean, extraction: unsureCurrency });
    expect(inv.status).toBe('needs_extraction_review');
    const [d] = await findings(o, inv.id);
    const body = { decision: 'approved', approved_action: 'correct_extraction_error', notes: 'Currency looks wrong' };
    const r = await resolve(o, d.id, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.discrepancy.status).toBe('investigating');
    expect(r.body.data.next_step).toMatchObject({ action: 'correct_field' });
    expect(r.body.data.next_step.message).toMatch(/still requires a field correction/);

    const again = await resolve(o, d.id, body);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already approved/i);
    expect(await env.db.query('select 1 from resolution_actions where discrepancy_id = $1', [d.id])).toHaveLength(1);

    const fresh = (await env.call('GET', `/api/invoices/${inv.id}`, { user: o.viewer })).body.data;
    const fix = await env.call('POST', `/api/invoices/${inv.id}/review-fields`, { user: o.reviewer, body: { updated_at: fresh.updated_at, values: { currency: 'USD' } } });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    expect((await findings(o, inv.id))[0].status).toBe('dismissed');
    expect((await env.call('GET', `/api/invoices/${inv.id}`, { user: o.viewer })).body.data.status).toBe('resolved');
    const hist = (await env.call('GET', `/api/discrepancies/${d.id}/history`, { user: o.viewer })).body.data;
    expect(hist.resolutions.map((x: any) => x.reviewer_notes)).toEqual(['Currency looks wrong']);
  });

  it('a supplier action awaits the supplier; review completion resolves with nothing left to do', async () => {
    const o = await org();
    const bad = await upload(o);
    const [d] = await findings(o, bad.id);
    const r = await resolve(o, d.id, { decision: 'approved', approved_action: 'request_corrected_invoice' });
    expect(r.body.data.discrepancy.status).toBe('awaiting_supplier');
    expect(r.body.data.next_step.action).toBe('await_supplier');
    const done = await resolve(o, d.id, { decision: 'approved', approved_action: 'approve_review_completion' });
    expect(done.body.data.discrepancy.status).toBe('resolved');
    expect(done.body.data.next_step.action).toBe('none');
  });

  it('a changed discrepancy may be decided again: reject then approve is allowed', async () => {
    const o = await org();
    const [d] = await findings(o, (await upload(o)).id);
    expect((await resolve(o, d.id, { decision: 'more_info_requested' })).status).toBe(200);
    expect((await resolve(o, d.id, { decision: 'more_info_requested' })).status).toBe(409);
    expect((await resolve(o, d.id, { decision: 'approved', approved_action: 'verify_po_amendment' })).status).toBe(200);
  });

  it('a missing purchase order points to upload_po with the reference', async () => {
    const o = await org(false);
    const inv = await upload(o, { ...clean, po_reference: 'PO-7777' });
    const [d] = await findings(o, inv.id);
    const r = await resolve(o, d.id, { decision: 'more_info_requested' });
    expect(r.body.data.next_step.action).toBe('upload_po');
    expect(r.body.data.next_step.message).toContain('PO-7777');
  });
});

describe('warnings follow the evidence', () => {
  it('a reviewer-confirmed currency is not asked again, even with low extractor confidence', async () => {
    const o = await org();
    const inv = await upload(o, { ...clean, extraction: { ...unsureCurrency, reviewed_fields: ['currency'] } });
    expect(inv.status).toBe('validated');
    expect(await findings(o, inv.id)).toHaveLength(0);
    expect((await env.call('POST', `/api/invoices/${inv.id}/process`, { user: o.reviewer })).status).toBe(200);
    expect(await findings(o, inv.id)).toHaveLength(0);
  });

  it('a confirmed currency that conflicts with the PO is still reported', async () => {
    const o = await org();
    const inv = await upload(o, { ...clean, currency: 'EUR', extraction: { ...unsureCurrency, reviewed_fields: ['currency'] } });
    expect((await findings(o, inv.id)).map((d) => d.discrepancy_type)).toEqual(['currency_mismatch']);
  });

  it('unknown tax is never zero: it is reported missing, not compared as 0.00', async () => {
    const o = await org();
    const inv = await upload(o, { ...clean, tax_amount: null, total_amount: '500.00', extraction: { method: 'ocr', confidence: 0.9, field_confidence: {}, missing: ['tax_amount'], uncertain: [] } });
    const ds = await findings(o, inv.id);
    expect(ds.every((d) => d.discrepancy_type === 'potential_extraction_error')).toBe(true);
    expect(inv.tax_amount).toBeNull();
  });
});
