import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLayoutText} from '../dist/layout-extraction.js';
import {arithmeticChecks} from '../dist/arithmetic.js';
import {extractedInvoice} from '../dist/server-inbox.js';

test('letterheads are suggested with evidence and do not override an explicit supplier', () => {
  const header = 'North Harbor Workshop\nTax Invoice\nEmail billing@north.example\nBill To: Buyer Co';
  const doc = parseLayoutText(header,'invoice');
  assert.equal(doc.vendor,'North Harbor Workshop');
  assert.equal(doc.extraction.fields.vendor.support,'uncertain');
  assert.equal(doc.customer,'Buyer Co');
  assert.equal(parseLayoutText(header+'\nSupplier: Actual Vendor','invoice').vendor,'Actual Vendor');
});

test('VAT-inclusive totals and European grouping preserve printed gross and derived net evidence', () => {
  const d = parseLayoutText('Description | Qty | Unit Price | Amount Incl\nParts | 1 | 1.190,00 | 1.190,00\nTOTAL (VAT inclusive) 1.190,00 €\nVAT 19% included in total 190,00 €','invoice');
  assert.deepEqual([d.currency,d.subtotal,d.tax,d.total], ['EUR',1000,190,1190]);
  assert.equal(d.extraction.fields.subtotal.support,'uncertain');
  assert.equal(d.extraction.fields.subtotal.evidence.length,1);
  assert.equal(d.lines[0].amount,1190);
  assert.deepEqual(d.arithmetic,[]);
});

test('discounts and freight reconcile independently and carry into signed-in validation metadata', () => {
  const d=parseLayoutText('Subtotal USD 1,000.00\nTrade Discount -$50.00\nFreight (LTL) $20.00\nSales Tax (10%) $95.00\nTotal USD 1,065.00','invoice');
  assert.deepEqual([d.subtotal,d.discount,d.shipping,d.tax,d.total],[1000,50,20,95,1065]);
  assert.deepEqual(d.arithmetic,[]);
  assert.ok(arithmeticChecks({...d,total:1064}).some(check=>check.code==='displayed_total'));
  const payload=extractedInvoice({method:'pdf',read:d,final:d});
  assert.equal(payload.extraction.support_labels.discount.reviewedValue,'50.00');
  assert.equal(payload.extraction.support_labels.shipping.reviewedValue,'20.00');
});

test('freight percentage rows preserve rate and amount without claiming a printed unit price', () => {
  const d=parseLayoutText('Description | Qty / Value | Rate | Amount\nFuel surcharge | 23 026.230 | 18.00% | 4 144.72\nSubtotal N$4 144.72\nVAT N$0.00\nTotal N$4 144.72','invoice');
  assert.deepEqual(d.lines[0],{sku:'',description:'Fuel surcharge',quantity:23026.23,unitPrice:null,amount:4144.72,ratePercent:18});
  assert.deepEqual(d.arithmetic,[]);
  assert.equal(extractedInvoice({method:'pdf',read:d,final:d}).lines[0].unit_price,'4144.72');
});
