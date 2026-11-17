import test from 'node:test';
import assert from 'node:assert/strict';
import {extractedInvoice, fileUpload, purchaseOrderRequest, toMoneyString} from '../dist/server-inbox.js';
import {investigationView, formatMoney} from '../dist/investigation-ui.js';
import {parseExtractedText} from '../dist/extraction.js';

const sample = {type: 'invoice', number: 'NS-1068', vendor: 'Northstar Paper Co.', poNumber: 'PO-2026-042', currency: 'USD', issued: '2026-11-13', due: '2026-12-13',
  lines: [{sku: 'PAPER-A4', description: 'A4 copy paper, case', quantity: 12, unitPrice: 45}, {sku: 'FOLDER-20', description: 'Project folders, pack of 20', quantity: 4, unitPrice: 30}], tax: 0, total: 660};

test('money strings come from numbers without float drift', () => {
  assert.equal(toMoneyString(45), '45.00');
  assert.equal(toMoneyString(0.1 + 0.2), '0.30');
  assert.equal(toMoneyString(1234567.5), '1234567.50');
  assert.equal(toMoneyString(null), null);
  assert.throws(() => toMoneyString(NaN), /amount/i);
  assert.equal(formatMoney('1234567.50', 'USD'), '$1,234,567.50');
  assert.equal(formatMoney('-60.00', 'EUR'), '-EUR 60.00');
  assert.equal(formatMoney(null), '—');
});

test('a structured JSON invoice maps every field with full confidence', () => {
  const x = extractedInvoice({method: 'json', read: sample, final: sample, sourceText: JSON.stringify(sample)});
  assert.equal(x.supplier_name, 'Northstar Paper Co.');
  assert.equal(x.invoice_number, 'NS-1068');
  assert.equal(x.po_reference, 'PO-2026-042');
  assert.equal(x.invoice_date, '2026-11-13');
  assert.equal(x.due_date, '2026-12-13');
  assert.equal(x.currency, 'USD');
  assert.equal(x.tax_amount, '0.00');
  assert.equal(x.total_amount, '660.00');
  assert.equal(x.subtotal, null, 'subtotal is not computed from lines');
  assert.deepEqual(x.lines[0], {sku: 'PAPER-A4', description: 'A4 copy paper, case', quantity: 12, unit_price: '45.00', line_total: null, tax_amount: null});
  assert.deepEqual(x.extraction.missing, []);
  assert.deepEqual(x.extraction.uncertain, []);
  assert.equal(x.extraction.method, 'json');
  assert.equal(x.extraction.confidence, 1);
  assert.equal(x.extraction.field_confidence.total_amount, 1);
  assert.equal(x.extraction.field_confidence.lines, 1);
});

test('missing fields stay null and are listed; nothing is filled in', () => {
  const partial = {type: 'invoice', vendor: 'Northstar Paper Co.', number: 'NS-1', currency: 'usd', lines: [], tax: null};
  const x = extractedInvoice({method: 'json', read: partial, final: partial, sourceText: null});
  assert.equal(x.po_reference, null);
  assert.equal(x.total_amount, null);
  assert.equal(x.tax_amount, null);
  assert.equal(x.invoice_date, null);
  assert.equal(x.currency, 'USD');
  assert.deepEqual(x.lines, []);
  assert.deepEqual(x.extraction.missing, ['po_reference', 'tax_amount', 'total_amount', 'lines']);
  assert.equal(x.extraction.field_confidence.total_amount, undefined);
  assert.equal(x.source_text, null);
});

test('fields the reviewer had to enter or correct are reported as uncertain, not as extractor-confident', () => {
  const text = 'Invoice: NS-1068\nPO reference: PO-2026-042\nPAPER-A4 A4 copy paper 12 45.00 540.00\nTax: 0.00';
  const read = parseExtractedText(text, 'invoice');
  read.currency = ''; // no Currency line on the document: the parser's USD default was not read
  const final = {...read, vendor: 'Northstar Paper Co.', currency: 'USD', total: 540};
  const x = extractedInvoice({method: 'ocr', read, final, sourceText: text});
  assert.equal(x.supplier_name, 'Northstar Paper Co.');
  assert.deepEqual(x.extraction.uncertain, ['supplier_name', 'currency', 'total_amount', 'lines']);
  assert.deepEqual(x.extraction.missing, []);
  assert.equal(x.extraction.field_confidence.invoice_number, 1);
  assert.equal(x.extraction.field_confidence.supplier_name, undefined);
  assert.equal(x.extraction.confidence, 0.43); // 4 of 7 read and confirmed
  assert.equal(x.extraction.method, 'ocr');
  assert.equal(x.lines[0].unit_price, '45.00');
});

test('invalid values are rejected rather than guessed', () => {
  assert.throws(() => extractedInvoice({method: 'json', read: {...sample, currency: 'US$X'}, final: {...sample, currency: 'US$X'}}), /currency/i);
  assert.throws(() => extractedInvoice({method: 'json', read: sample, final: {...sample, lines: [{sku: 'A', description: 'x', quantity: 0, unitPrice: 1}]}}), /quantity/i);
  const badDate = extractedInvoice({method: 'json', read: {...sample, due: 'next week'}, final: {...sample, due: 'next week'}});
  assert.equal(badDate.due_date, null);
});

test('fileUpload hashes, encodes and enforces the 3 MB limit', async () => {
  const f = await fileUpload({name: 'inv.json', type: '', bytes: new TextEncoder().encode('abc')});
  assert.deepEqual(f, {name: 'inv.json', mime_type: 'application/json', size_bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', content_base64: 'YWJj'});
  assert.equal((await fileUpload({name: 'scan.JPG', type: '', bytes: new Uint8Array([1])})).mime_type, 'image/jpeg');
  await assert.rejects(fileUpload({name: 'big.pdf', type: 'application/pdf', bytes: new Uint8Array(3 * 1024 * 1024 + 1)}), /3 MB/);
  await assert.rejects(fileUpload({name: 'notes.docx', type: 'application/msword', bytes: new Uint8Array([1])}), /PDF/);
});

test('purchaseOrderRequest builds the contract body and refuses incomplete orders', () => {
  const po = {type: 'purchase_order', number: 'PO-2026-042', vendor: 'Northstar Paper Co.', poNumber: 'PO-2026-042', currency: 'USD', lines: [{sku: 'PAPER-A4', description: 'A4 copy paper, case', quantity: 12, unitPrice: 40}], tax: 0, total: 480};
  assert.deepEqual(purchaseOrderRequest(po), {supplier_name: 'Northstar Paper Co.', purchase_order_number: 'PO-2026-042', currency: 'USD', tax_amount: '0.00', total_amount: '480.00',
    lines: [{sku: 'PAPER-A4', description: 'A4 copy paper, case', quantity: 12, unit_price: '40.00', line_total: null, tax_amount: null}]});
  assert.throws(() => purchaseOrderRequest({...po, total: null}), /total/i);
  assert.throws(() => purchaseOrderRequest({...po, lines: []}), /line/i);
});

// ---------- investigation panel view-model ----------
const D = 'd0000000-0000-4000-8000-000000000001', L1 = 'invoice_line:11111111-1111-4111-8111-111111111111', P1 = 'po_line:22222222-2222-4222-8222-222222222222';
const dto = (status, extra = {}) => ({id: 'i1', discrepancy_id: D, investigation_status: status, model_identifier: 'm', prompt_version: 'investigate-v1', result: null, error: null, usage: null, retry_available: status === 'failed', created_at: '2026-11-15T00:00:00Z', completed_at: null, ...extra});
const result = (status, extra = {}) => ({schema_version: 1, investigation_id: 'i1', invoice_id: 'inv', discrepancy_id: D, discrepancy_type: 'unit_price_mismatch', status,
  summary: 'Invoice unit price is $45.00 against $40.00 ordered.', findings: [{claim: 'Unit price differs by $5.00 on 12 units.', evidence_ids: [L1, P1, 'po:gone']}],
  possible_causes: ['A price increase the PO does not reflect.'], missing_information: ['Any PO amendment.'],
  evidence: [{id: L1, label: 'Invoice line 1', value: 'PAPER-A4: 12 × 45.00 = 540.00', page: 1}, {id: P1, label: 'PO line 1', value: 'PAPER-A4: 12 × 40.00 = 480.00'}],
  verified_financial_impact: {currency: 'USD', amount: '60.00', source: 'deterministic_engine'}, recommended_action: 'request_corrected_invoice', confidence: 'high', requires_human_approval: true, ...extra});

test('no investigation yet', () => {
  const v = investigationView(null);
  assert.equal(v.state, 'none');
  assert.equal(v.polling, false);
  assert.equal(v.result, null);
});

test('queued and in progress are distinct, polling states without results', () => {
  const q = investigationView(dto('queued')), p = investigationView(dto('in_progress'));
  assert.equal(q.state, 'queued');
  assert.equal(p.state, 'in_progress');
  assert.notEqual(q.label, p.label);
  assert.notEqual(q.message, p.message);
  assert.ok(q.polling && p.polling);
  assert.equal(q.canRetry, false);
  assert.equal(q.result, null);
});

test('completed shows confirmed findings with their evidence, unconfirmed causes, action, confidence and the engine amount', () => {
  const v = investigationView(dto('completed', {result: result('completed')}));
  assert.equal(v.state, 'completed');
  assert.equal(v.polling, false);
  const r = v.result;
  assert.equal(r.summary, 'Invoice unit price is $45.00 against $40.00 ordered.');
  assert.equal(r.findings[0].evidence.length, 3);
  assert.equal(r.findings[0].evidence[0].page, 1);
  assert.equal(r.findings[0].evidence[1].page, undefined);
  assert.equal(r.findings[0].evidence[2].missing, true, 'an uncited id is shown as unavailable, not dropped');
  assert.deepEqual(r.possibleCauses, ['A price increase the PO does not reflect.']);
  assert.deepEqual(r.missingInformation, ['Any PO amendment.']);
  assert.equal(r.action.code, 'request_corrected_invoice');
  assert.match(r.action.text, /corrected invoice/i);
  assert.equal(r.confidence, 'High');
  assert.equal(r.impact.text, '$60.00');
  assert.match(r.impact.source, /deterministic/i);
  assert.equal(r.approvalRequired, true);
});

test('a missing engine amount is stated, never invented', () => {
  const v = investigationView(dto('completed', {result: result('completed', {verified_financial_impact: null})}));
  assert.equal(v.result.impact, null);
});

test('insufficient evidence is its own state and keeps the result', () => {
  const v = investigationView(dto('insufficient_evidence', {result: result('insufficient_evidence', {recommended_action: 'insufficient_evidence', confidence: 'low', findings: []})}));
  assert.equal(v.state, 'insufficient_evidence');
  assert.match(v.label, /insufficient/i);
  assert.equal(v.result.confidence, 'Low');
  assert.deepEqual(v.result.missingInformation, ['Any PO amendment.']);
});

test('failed shows the error and offers retry; an unknown status is surfaced as a failure', () => {
  const v = investigationView(dto('failed', {error: 'Model call timed out'}));
  assert.equal(v.state, 'failed');
  assert.equal(v.canRetry, true);
  assert.match(v.message, /timed out/);
  const odd = investigationView(dto('exploded'));
  assert.equal(odd.state, 'failed');
  assert.equal(odd.canRetry, true);
  const noRetry = investigationView(dto('failed', {retry_available: false, error: null}));
  assert.equal(noRetry.canRetry, false);
  assert.ok(noRetry.message.length > 0);
});

test('preserves printed contradictions, dates and source review labels in upload',()=>{
 const raw=parseExtractedText('Vendor: Example\nInvoice: X\nPO reference: P\nCurrency: USD\nInvoice date: 2026-11-16\nA Boxes 2 50.00 90.00\nTax: 0.00\nTotal: 100.00','invoice');
 const x=extractedInvoice({method:'pdf_text',read:raw,final:raw});
 assert.equal(x.lines[0].line_total,'90.00');assert.equal(x.invoice_date,'2026-11-16');assert.ok(x.extraction.uncertain.includes('lines'));assert.match(x.extraction.source_refs['lines.0.amount'].excerpt,/90.00/);assert.match(x.extraction.confidence_meaning,/not a calibrated probability/);
});
