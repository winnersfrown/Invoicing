import test from 'node:test';import assert from 'node:assert/strict';import {parseExtractedText} from '../dist/extraction.js';
test('extracts labeled fields and line amounts without prefilled sample values',()=>{const d=parseExtractedText('Vendor: Test Co\nInvoice: INV-8\nPO reference: PO-7\nCurrency: USD\nBOX-1 Storage boxes 3 25.00 75.00\nTax: 0.00\nTotal: 75.00','invoice');assert.equal(d.vendor,'Test Co');assert.equal(d.number,'INV-8');assert.equal(d.poNumber,'PO-7');assert.equal(d.lines[0].quantity,3);assert.equal(d.lines[0].unitPrice,25);assert.equal(d.total,75);});
test('unknown amounts stay missing for human review',()=>{const d=parseExtractedText('Unreadable invoice','invoice');assert.equal(d.total,null);assert.equal(d.tax,null);assert.equal(d.vendor,'');assert.equal(d.lines.length,0);});

test('separates a currency amount fused into an OCR description using the price column', () => {
 const row = (tokens, row) => ({
  text: tokens.map(token => token.text).join(' '), tokens, page: 1, row, method: 'ocr', ocrConfidence: 95,
 });
 const token = (text, x, width) => ({text, x, width});
 const layout = [
  row([token('Description', 40, 70), token('Qty', 170, 24), token('Unit Price', 213, 45), token('Amount', 302, 40)], 1),
  row([token('Social Media Strategy Plan $100.00', 40, 218), token('1', 172, 8), token('$100.00', 302, 40)], 2),
  row([token('Gift Card $100.00', 40, 107), token('2', 172, 8), token('$95.00', 217, 41), token('$190.00', 302, 40)], 3),
  row([token('Brand Consultation $75.00', 40, 218)], 4),
 ];
 const doc = parseExtractedText('', 'invoice', layout);
 assert.deepEqual(doc.lines, [
  {sku:'', description:'Social Media Strategy Plan', quantity:1, unitPrice:100, amount:100},
  {sku:'', description:'Gift Card $100.00', quantity:2, unitPrice:95, amount:190},
  {sku:'', description:'Brand Consultation', quantity:null, unitPrice:75, amount:null},
 ]);
 const description = doc.extraction.fields['lines.0.description'];
 assert.equal(description.support, 'uncertain');
 assert.match(description.evidence[0].text, /Plan \$100\.00/);
});
