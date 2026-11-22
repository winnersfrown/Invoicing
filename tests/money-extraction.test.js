import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLayoutText} from '../dist/layout-extraction.js';
import {arithmeticChecks, arithmeticReview, correctField, pendingConfirmations, adjustmentsOf} from '../dist/arithmetic.js';
import {withReviewerConfirmations, applyConfirmations} from '../dist/extraction-review.js';
import {readExchangeRate, readSummary} from '../dist/invoice-money.js';

// Reproductions of the evaluation cases, written as text-layer invoices. Not the 109-invoice dataset.
const parse = text => parseLayoutText(text, 'invoice');
const fuel = `Supplier: Ridgeway Industrial Supply
Currency: USD
Description | Qty | Unit Price | Amount
Pallet wrap rolls | 30 | 95.00 | 2,850.00
Subtotal: $2,850.00
Freight: $175.00
Fuel surcharge: $342.00
Sales tax (6.5%): $185.25
Total: $3,552.25`;
const credit = `Supplier: Brightline Software
Currency: USD
Description | Qty | Unit Price | Amount
Annual support plan | 1 | 2,598.00 | 2,598.00
Subtotal: $2,598.00
Credit applied (CM-1043): -$150.00
Sales tax (6%): $146.88
Total: $2,594.88`;
const zar = `Supplier: Cape Route Consulting
Description | Qty | Unit Price | Amount
Advisory days | 10 | 200.00 | 2,000.00
Subtotal USD 2,000.00
VAT 15% USD 300.00
Total USD 2,300.00
Exchange rate: 1 USD = 18.25 ZAR
Amount due ZAR 41,975.00`;

test('clean-us-fuel-surcharge: freight and fuel surcharge are separate adjustments; tax on the items only', () => {
  const d = parse(fuel);
  assert.deepEqual(d.adjustments.map(a => [a.kind, a.cents, a.appliesTo]), [['freight', 17500, 'total'], ['fuel_surcharge', 34200, 'total']]);
  assert.deepEqual(d.arithmetic, []);
  assert.deepEqual(d.arithmeticReview.uncertain, []);
  assert.equal(d.arithmeticReview.passed.find(c => c.code === 'tax_rate').basisCents, 285000);
  assert.match(d.adjustments[1].sourceText, /Fuel surcharge/);
  assert.equal(d.adjustments[1].evidence[0].text, 'Fuel surcharge: $342.00');
});

test('clean-us-credit-applied: a credit before tax reduces the total and the taxable basis', () => {
  const d = parse(credit);
  assert.deepEqual(d.adjustments.map(a => [a.kind, a.cents]), [['credit_applied', -15000]]);
  assert.deepEqual(d.arithmetic, []);
  assert.equal(d.arithmeticReview.passed.find(c => c.code === 'tax_rate').basisCents, 244800);
});

test('the same two invoices with a genuinely wrong total still raise a confirmed contradiction with numbers and evidence', () => {
  for (const [text, from, to] of [[fuel, '3,552.25', '3,652.25'], [credit, '2,594.88', '2,744.88']]) {
    const [check] = parse(text.replace(from, to)).arithmetic.filter(c => c.code === 'displayed_total');
    assert.equal(check.status, 'contradiction');
    assert.equal(check.differenceCents, 10000 + (text === credit ? 5000 : 0));
    assert.match(check.message, /displayed .* calculated/);
    assert.ok(check.evidence.some(e => e.text.startsWith('Total')));
    assert.ok(Object.keys(check.numbers.inputs).includes('subtotal'));
  }
});

test('amount billed and balance due after a deposit are both kept and reconciled', () => {
  const text = 'Currency: USD\nSubtotal: 1,000.00\nSales tax (8%): 80.00\nTotal: 1,080.00\nLess deposit paid: -300.00\nBalance due: 780.00';
  const d = parse(text);
  assert.deepEqual([d.total, d.amountDue, d.adjustments[0].kind, d.adjustments[0].appliesTo], [1080, 780, 'payment', 'balance']);
  assert.deepEqual(d.arithmetic, []);
  assert.equal(parse(text.replace('780.00', '880.00')).arithmetic[0].code, 'amount_due');
});

test('old records with one shipping and one discount value still reconcile', () => {
  const old = {subtotal: 1000, shipping: 20, discount: 50, tax: 95, total: 1065, lines: []};
  assert.deepEqual(adjustmentsOf(old).map(a => [a.kind, a.cents]), [['shipping', 2000], ['discount', -5000]]);
  assert.deepEqual(arithmeticChecks(old), []);
  assert.equal(arithmeticChecks({...old, total: 1064})[0].code, 'displayed_total');
});

test('USD-priced, ZAR-payable: both currencies and amounts kept, no mixed arithmetic, conversion checked separately', () => {
  const d = parse(zar);
  assert.deepEqual([d.currency, d.total, d.pricingCurrency, d.pricingTotal], ['ZAR', 41975, 'USD', 2300]);
  assert.deepEqual([d.exchangeRate.base, d.exchangeRate.quote, d.exchangeRate.rate], ['USD', 'ZAR', 18.25]);
  assert.deepEqual(d.arithmetic, []);
  assert.ok(d.arithmeticReview.passed.every(c => c.currency === 'USD'));
  const [conversion] = d.arithmeticReview.conversions;
  assert.deepEqual([conversion.status, conversion.currency], ['pass', 'ZAR']);
  assert.match(conversion.label, /tolerance ±/);
  const wrong = parse(zar.replace('41,975.00', '42,975.00'));
  assert.deepEqual(wrong.arithmetic.map(c => c.code), ['conversion']);
});

test('dual-currency variants: rand symbol, EUR reference total, CAD priced / USD payable', () => {
  const rand = parse(zar.replace('Amount due ZAR 41,975.00', 'Amount due R 41 975.00'));
  assert.deepEqual([rand.currency, rand.total, rand.extraction.fields.currency.support], ['ZAR', 41975, 'uncertain']);
  assert.deepEqual(rand.arithmetic, []);

  const gbp = parse('Subtotal £1,000.00\nVAT 20% £200.00\nTotal GBP 1,200.00\nExchange rate: 1 GBP = 1.17 EUR\nEquivalent EUR 1,404.00 (for reference only)');
  assert.deepEqual([gbp.currency, gbp.total, gbp.pricingCurrency], ['GBP', 1200, undefined]);
  assert.deepEqual(gbp.referenceTotal, {currency: 'EUR', value: 1404});
  assert.deepEqual(gbp.arithmetic, []);
  assert.equal(gbp.arithmeticReview.conversions[0].status, 'pass');

  const cad = parse('Subtotal CAD 1,000.00\nGST 5% CAD 50.00\nPST 7% CAD 70.00\nTotal CAD 1,120.00\nExchange rate (CAD/USD): 0.7300\nAmount payable (USD): 817.60');
  assert.deepEqual([cad.currency, cad.total, cad.pricingCurrency, cad.pricingTotal, cad.tax], ['USD', 817.6, 'CAD', 1120, 120]);
  assert.deepEqual(cad.taxes.map(t => [t.label, t.ratePercent, t.cents]), [['GST', 5, 5000], ['PST', 7, 7000]]);
  assert.deepEqual(cad.arithmetic, []);
  assert.equal(cad.arithmeticReview.passed.filter(c => c.code === 'tax_rate').length, 2);
});

test('a lone "$" stays ambiguous until the reviewer confirms the currency', () => {
  const d = parse('Vendor: Harbour Print Co\nSubtotal: $1,000.00\nTax (8%): $80.00\nTotal: $1,080.00');
  assert.equal(d.currency, '');
  const [pending] = pendingConfirmations(d);
  assert.equal(pending.path, 'currency');
  assert.ok(pending.candidates.some(c => c.value === 'CAD') && pending.candidates.some(c => c.value === 'USD'));
  assert.deepEqual(d.arithmetic, []);
  assert.throws(() => applyConfirmations(d, {}), /currency/);
  const confirmed = applyConfirmations(d, {currency: 'CAD'});
  assert.deepEqual([confirmed.currency, pendingConfirmations(confirmed).length], ['CAD', 0]);
  // In the dialog, choosing a candidate (or editing the field) settles it.
  assert.equal(pendingConfirmations(withReviewerConfirmations({...d, currency: 'USD'}, d, new Set())).length, 0);
  assert.equal(pendingConfirmations(withReviewerConfirmations(d, d, new Set())).length, 1);
});

test('VAT at two rates: printed bases are checked; without bases the rate check is uncertain, not an error', () => {
  const based = parse('Currency: EUR\nSubtotal: 1.100,00\nVAT 20% on 1.000,00: 200,00\nVAT 5% on 100,00: 5,00\nTotal: 1.305,00');
  assert.deepEqual(based.taxes.map(t => [t.ratePercent, t.basisCents, t.cents]), [[20, 100000, 20000], [5, 10000, 500]]);
  assert.deepEqual([based.tax, based.arithmetic], [205, []]);
  const unbased = parse('Currency: EUR\nSubtotal: 1.100,00\nMwSt 19%: 190,00\nMwSt 7%: 7,00\nTotal: 1.297,00');
  assert.deepEqual(unbased.arithmetic, []);
  assert.equal(unbased.arithmeticReview.uncertain.filter(c => c.code === 'tax_rate').length, 2);
  assert.equal(parse('Currency: EUR\nSubtotal: 1.100,00\nMwSt 19%: 190,00\nMwSt 7%: 7,00\nTotal: 1.397,00').arithmetic[0].code, 'displayed_total');
});

test('VAT-inclusive prices, zero-rated and exempt VAT are valid', () => {
  const inclusive = parse('Currency: EUR\nDescription | Qty | Unit Price | Amount\nDesk lamp | 2 | 60,00 | 120,00\nTotal: 120,00\nTVA 20% included: 20,00');
  assert.deepEqual([inclusive.subtotal, inclusive.tax, inclusive.total, inclusive.taxInclusive, inclusive.arithmetic], [100, 20, 120, true, []]);
  const zero = parse('Currency: GBP\nSubtotal: 500.00\nVAT 0% (zero-rated): 0.00\nTotal: 500.00');
  assert.deepEqual([zero.tax, zero.taxes[0].treatment, zero.arithmetic, zero.arithmeticReview.uncertain], [0, 'zero_rated', [], []]);
  const exempt = parse('Currency: GBP\nSubtotal: 750.00\nVAT: Exempt\nTotal: 750.00');
  assert.deepEqual([exempt.tax, exempt.taxes[0].treatment, exempt.arithmetic, exempt.arithmeticReview.uncertain], [0, 'exempt', [], []]);
  for (const label of ['IVA 21%', 'BTW 21%', 'USt 19%', 'HST 13%', 'QST 9.975%']) assert.equal(readSummary(`${label} 10.00`).key, 'tax', label);
});

test('a blank tax is unknown, not zero, and the total check is uncertain', () => {
  const d = parse('Currency: USD\nSubtotal: 100.00\nTax:\nTotal: 108.00');
  assert.equal(d.tax, null);
  assert.equal(d.extraction.fields.tax.support, 'missing');
  assert.deepEqual(d.arithmetic, []);
  assert.match(d.arithmeticReview.uncertain[0].message, /not treated as zero/);
});

const ocrRows = ['Currency: USD', 'Subtotal: 2,850.00', 'Freight: 175.00', 'Fuel surcharge: 342.00', 'Sales tax (6.5%): 185.25', 'Total: 3,557.25']
  .map((text, i) => ({text, page: 1, row: i + 1, method: 'ocr', ocrConfidence: 92}));

test('an OCR misread total (2 read as 7) is uncertain and flagged for confirmation, not an error', () => {
  const d = parseLayoutText('', 'invoice', ocrRows);
  assert.deepEqual(d.arithmetic, []);
  const [check] = d.arithmeticReview.uncertain;
  assert.deepEqual([check.code, check.suspects[0].path, check.suspects[0].candidateCents], ['displayed_total', 'total', 355225]);
  assert.match(check.message, /OCR misread/);
  assert.equal(d.extraction.fields.total.needsConfirmation, true);
  assert.ok(d.extraction.fields.total.candidates.some(c => c.value === 3552.25));
});

test('a reviewer correction reruns the checks: correcting clears the warning, confirming the misread raises it', () => {
  const d = parseLayoutText('', 'invoice', ocrRows);
  const corrected = correctField(d, 'total', 3552.25);
  assert.deepEqual([corrected.arithmetic, corrected.arithmeticReview.uncertain, pendingConfirmations(corrected)], [[], [], []]);
  // Subtotal and fuel surcharge are also one digit from reconciling, so each is flagged until the reviewer settles it.
  assert.deepEqual(pendingConfirmations(d).map(p => p.path).sort(), ['adjustments.1', 'subtotal', 'total']);
  assert.equal(correctField(d, 'total', 3557.25).arithmetic.length, 0);
  const confirmedAsRead = applyConfirmations(d, {total: 3557.25, subtotal: 2850, 'adjustments.1': 342});
  assert.equal(confirmedAsRead.arithmetic[0].status, 'contradiction');
  // A genuinely wrong amount in a text PDF is not treated as an OCR misread.
  assert.equal(arithmeticReview({...d, extraction: undefined}).contradictions.length, 1);
});

test('exchange-rate notations', () => {
  assert.deepEqual(readExchangeRate('Exchange rate: 1 USD = 18.25 ZAR'), {base: 'USD', quote: 'ZAR', rate: 18.25, decimals: 2, sourceText: 'Exchange rate: 1 USD = 18.25 ZAR'});
  assert.deepEqual(readExchangeRate('Rate of exchange (EUR/GBP): 0.8571').rate, 0.8571);
  assert.equal(readExchangeRate('Exchange rate: 18.25').base, '');
  assert.equal(readExchangeRate('Payment terms: Net 30'), null);
});

// Prompted by the external benchmark: a qualifier before "freight" hid the fee from the total check.
test('qualified freight labels are read as freight fees', () => {
  for (const label of ['Accessorial Freight', 'Inbound freight', 'Outbound Freight Charges', 'Additional delivery fee'])
    assert.deepEqual([readSummary(`${label}  $120.00`)?.kind, readSummary(`${label}  $120.00`)?.value], ['freight', 120], label);
  assert.equal(readSummary('Freight forwarding agent  $120.00'), null);
});
