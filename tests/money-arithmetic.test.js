import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLayoutText} from '../dist/layout-extraction.js';
import {arithmeticChecks, arithmeticReview, adjustmentsOf, correctField, convertCents} from '../dist/arithmetic.js';
import {applyConfirmations} from '../dist/extraction-review.js';
import {newCase, correctExtraction} from '../dist/case-engine.js';
import {extractedInvoice} from '../dist/server-inbox.js';
import {clean, wrong} from './money-fixtures.js';

const parse = text => parseLayoutText(text, 'invoice');
const ocrRows = (text, confidence = 70) => text.split('\n').map((t, i) => ({text: t, page: 1, row: i + 1, method: 'ocr', ocrConfidence: confidence}));

test('fuel surcharge and freight reconcile; a wrong total is still a contradiction', () => {
  const d = parse(clean['clean-us-fuel-surcharge']);
  assert.deepEqual(d.adjustments.map(a => [a.kind, a.cents, a.appliesTo]), [['freight', 17500, 'total'], ['fuel_surcharge', 34200, 'total']]);
  assert.match(d.adjustments[1].sourceText, /Fuel surcharge \$342\.00/);
  assert.ok(d.adjustments[1].evidence.length);
  assert.deepEqual([d.subtotal, d.tax, d.total, d.arithmetic], [2850, 185.25, 3552.25, []]);
  const bad = parse(wrong(clean['clean-us-fuel-surcharge']));
  assert.equal(bad.arithmetic[0].code, 'displayed_total');
  assert.deepEqual([bad.arithmetic[0].displayedCents, bad.arithmetic[0].expectedCents], [356225, 355225]);
  assert.ok(bad.arithmetic[0].evidence.some(e => /Total \$3,562\.25/.test(e.text)));
});

test('credit applied before the total reconciles and reaches the server as a reduction', () => {
  const d = parse(clean['clean-us-credit-applied']);
  assert.deepEqual(d.adjustments.map(a => [a.kind, a.cents, a.appliesTo]), [['credit_applied', -15000, 'total']]);
  assert.deepEqual(d.arithmetic, []);
  assert.equal(extractedInvoice({method: 'pdf', read: d, final: d}).extraction.support_labels.discount.reviewedValue, '150.00');
  assert.equal(parse(wrong(clean['clean-us-credit-applied'])).arithmetic[0].code, 'displayed_total');
});

test('deposits keep the billed total and the balance due separately', () => {
  const d = parse(clean['us-deposit-balance-due']);
  assert.deepEqual([d.total, d.amountDue, d.adjustments[0].appliesTo, d.arithmetic], [1050, 750, 'balance', []]);
  assert.equal(parse(wrong(clean['us-deposit-balance-due'])).arithmetic[0].code, 'amount_due');
});

test('old records with shipping/discount map into the adjustment list', () => {
  assert.deepEqual(adjustmentsOf({shipping: 20, discount: 50}).map(a => [a.kind, a.cents]), [['shipping', 2000], ['discount', -5000]]);
  assert.deepEqual(arithmeticChecks({subtotal: 1000, shipping: 20, discount: 50, tax: 95, total: 1065}), []);
  assert.equal(arithmeticChecks({subtotal: 1000, shipping: 20, discount: 50, tax: 95, total: 1064}).length, 1);
});

test('USD-priced, ZAR-payable invoice keeps both currencies and never mixes them', () => {
  const d = parse(clean['usd-priced-zar-payable']);
  assert.deepEqual([d.pricingCurrency, d.pricingTotal, d.currency, d.total], ['USD', 2300, 'ZAR', 41975]);
  assert.deepEqual([d.exchangeRate.base, d.exchangeRate.quote, d.exchangeRate.rate], ['USD', 'ZAR', 18.25]);
  const r = arithmeticReview(d);
  assert.deepEqual(r.contradictions, []);
  assert.ok(r.passed.some(c => c.code === 'displayed_total' && c.currency === 'USD'));
  assert.equal(r.conversions[0].status, 'pass');
  assert.match(r.conversions[0].label, /tolerance ±11\.51 ZAR/);
  const bad = parse(clean['usd-priced-zar-payable'].replace('ZAR 41,975.00', 'ZAR 43,975.00'));
  assert.equal(bad.arithmetic[0].code, 'conversion');
  const badUsd = parse(clean['usd-priced-zar-payable'].replace('Total USD 2,300.00', 'Total USD 2,310.00'));
  assert.equal(badUsd.arithmetic.find(c => c.code === 'displayed_total').currency, 'USD');
});

test('EUR reference total is reported, not treated as the amount due', () => {
  const d = parse(clean['gbp-with-eur-reference']);
  assert.deepEqual([d.currency, d.total, d.referenceTotal], ['GBP', 1200, {currency: 'EUR', value: 1404}]);
  assert.equal(arithmeticReview(d).conversions[0].code, 'reference_conversion');
  assert.deepEqual(d.arithmetic, []);
});

test('CAD-priced, USD-payable invoice with GST and PST', () => {
  const d = parse(clean['cad-priced-usd-payable']);
  assert.deepEqual([d.pricingCurrency, d.currency, d.tax, d.taxes.map(t => t.label)], ['CAD', 'USD', 120, ['GST', 'PST']]);
  assert.deepEqual(d.arithmetic, []);
  assert.deepEqual(convertCents(112000, 'CAD', 'USD', d.exchangeRate), {cents: 81872, toleranceCents: 7});
  assert.equal(parse(wrong(clean['cad-priced-usd-payable'])).arithmetic[0].code, 'conversion');
});

test('a bare $ stays unconfirmed until the reviewer chooses the currency', () => {
  const d = parse('Description | Qty | Unit Price | Amount\nWidgets | 4 | 25.00 | 100.00\nSubtotal $100.00\nTax $0.00\nTotal $100.00');
  assert.equal(d.currency, '');
  assert.equal(d.extraction.fields.currency.needsConfirmation, true);
  assert.ok(d.extraction.fields.currency.candidates.some(c => c.value === 'CAD'));
  assert.throws(() => applyConfirmations(d, {}), /currency/);
  assert.equal(applyConfirmations(d, {currency: 'CAD'}).currency, 'CAD');
});

test('several taxes, inclusive VAT, zero-rated and exempt are valid', () => {
  const two = parse(clean['eur-two-vat-rates']);
  assert.deepEqual(two.taxes.map(t => [t.ratePercent, t.basisCents, t.cents]), [[7, 10000, 700], [19, 20000, 3800]]);
  assert.deepEqual(two.arithmetic, []);
  assert.equal(parse(clean['eur-two-vat-rates'].replace('VAT 19% on 200.00 38.00', 'VAT 19% on 200.00 39.00').replace('345.00', '346.00')).arithmetic[0].code, 'tax_rate');
  const county = parse(clean['us-state-county-tax']);
  assert.deepEqual([county.taxes.length, county.tax, county.arithmetic], [2, 45, []]);
  const inclusive = parse(clean['eur-vat-inclusive']);
  assert.deepEqual([inclusive.taxInclusive, inclusive.subtotal, inclusive.tax, inclusive.total, inclusive.arithmetic], [true, 100, 19, 119, []]);
  for (const id of ['gbp-zero-rated', 'eur-exempt']) {
    const d = parse(clean[id]);
    assert.deepEqual([d.tax, d.arithmetic], [0, []], id);
    assert.match(d.extraction.fields['taxes.0'].reason, /valid zero tax/);
  }
});

test('a blank tax is unknown, not zero, and the total check is uncertain', () => {
  const d = parse('Description | Qty | Unit Price | Amount\nTraining | 1 | 800.00 | 800.00\nSubtotal USD 800.00\nTax:\nTotal USD 860.00');
  assert.equal(d.tax, null);
  assert.equal(d.extraction.fields.tax.support, 'missing');
  assert.deepEqual(d.arithmetic, []);
  assert.match(arithmeticReview(d).uncertain[0].message, /not treated as zero/);
});

test('an OCR misread total is flagged uncertain, not erroneous, and a correction clears it', () => {
  const misread = clean['clean-us-fuel-surcharge'].replace('Total $3,552.25', 'Total $3,557.25');
  const d = parseLayoutText('', 'invoice', ocrRows(misread));
  assert.deepEqual(d.arithmetic, []);
  const u = d.arithmeticReview.uncertain.find(c => c.code === 'displayed_total');
  assert.match(u.message, /may be an OCR misread/);
  assert.deepEqual(u.suspects[0], {path: 'total', readCents: 355725, candidateCents: 355225});
  assert.equal(d.extraction.fields.total.needsConfirmation, true);
  const fixed = correctField(d, 'total', 3552.25);
  assert.deepEqual([fixed.arithmetic, fixed.arithmeticReview.uncertain.filter(c => c.code === 'displayed_total')], [[], []]);
  // Confirming the total as printed is not enough while other inputs are low-confidence OCR reads...
  const asPrinted = correctField(d, 'total', 3557.25);
  assert.deepEqual(asPrinted.arithmetic, []);
  assert.doesNotMatch(asPrinted.arithmeticReview.uncertain[0].message, /[^b]total: low-confidence/);
  // ...once the whole extraction is reviewed, the disagreement is a confirmed contradiction.
  assert.equal(arithmeticChecks({...asPrinted, extractionReviewed: true})[0].code, 'displayed_total');
  // Even a confident OCR read is held while one digit would reconcile it; a total wrong in several digits is a contradiction.
  assert.deepEqual(parseLayoutText('', 'invoice', ocrRows(misread, 95)).arithmetic, []);
  const several = clean['clean-us-fuel-surcharge'].replace('Total $3,552.25', 'Total $3,600.00');
  assert.equal(parseLayoutText('', 'invoice', ocrRows(several, 95)).arithmetic[0].code, 'displayed_total');
});

test('an unreadable labelled amount is flagged and never zero', () => {
  const d = parse('Description | Qty | Unit Price | Amount\nA | 1 | 10.00 | 10.00\nSubtotal 10.00\nFreight 1,0.00\nTax 0.00\nTotal 20.00');
  assert.equal(d.adjustments[0].cents, null);
  assert.equal(d.extraction.fields['adjustments.0'].needsConfirmation, true);
  assert.deepEqual(d.arithmetic, []);
});

test('a reviewer correction in a case reruns the checks and clears the warning', () => {
  const parsed = parse(clean['clean-us-fuel-surcharge']);
  const invoice = {...parsed, number: 'F-1', vendor: 'Fuel Co', poNumber: 'PO-1', lines: parsed.lines.map(l => ({...l, sku: 'DP-1'}))};
  const po = {...structuredClone(invoice), type: 'purchase_order', number: 'PO-1'};
  const c = newCase({...invoice, total: 3562.25}, po);
  assert.ok(c.comparison.arithmetic.some(a => a.code === 'displayed_total'));
  const fixed = correctExtraction(c, 'total', 3552.25, 'Original shows 3,552.25');
  assert.deepEqual(fixed.comparison.arithmetic, []);
  assert.equal(fixed.status, 'matched');
  assert.equal(fixed.paymentApproved, false);
  assert.match(fixed.events.at(-1).detail, /Arithmetic warnings 1 → 0/);
});

test('the shared confirmation rule also covers ambiguous issue and due dates', () => {
  const date = {value: null, needsConfirmation: true, label: 'Invoice date', sourceText: 'Date: 09/03/2026', reason: 'Day and month order is ambiguous.',
    candidates: [{value: '2026-03-09', label: '9 March 2026'}, {value: '2026-09-03', label: '3 September 2026'}], evidence: []};
  const d = {date: '', due: '', lines: [], extraction: {fields: {date, due: {...date, label: 'Due date', candidates: [{value: '2026-04-09', label: '9 April 2026'}]}}}};
  assert.throws(() => applyConfirmations(d, {date: '2026-03-09'}), /Due date/);
  const done = applyConfirmations(d, {date: '2026-03-09', due: '2026-04-09'});
  assert.deepEqual([done.date, done.due, done.extraction.fields.date.confirmed, done.extraction.fields.due.needsConfirmation], ['2026-03-09', '2026-04-09', true, false]);
});
