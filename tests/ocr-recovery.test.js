import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractedText } from '../dist/extraction.js';
import { reviewExisting } from '../dist/extraction-review.js';
import { alignOcrRows } from '../dist/ocr-layout.js';

test('currency markers take precedence over catalog codes and address suggestions', () => {
  const text='Vendor: Test Co\nChicago, IL 60601\nCOP294 Paper 2 12.00 24.00\nSubtotal $24.00\nTotal N$24.00';
  const invoice=parseExtractedText(text,'invoice');
  assert.equal(invoice.currency,'NAD');
  assert.match(invoice.extraction.fields.currency.evidence[0].text,/Total N\$/);
  assert.equal(parseExtractedText(text.replace('N$24.00','$24.00'),'invoice').extraction.fields.currency.support,'uncertain');
  assert.equal(parseExtractedText('Total $24.00','invoice').currency,'');
});

test('supplier reference labels never populate the supplier name', () => {
  const invoice=parseExtractedText('Erongo Freight Ltd\nTax Invoice\nSupplier Inv No: SI191305\nContainer: IPPU8832877\nInvoice No: KN-71210','invoice');
  assert.equal(invoice.vendor,'Erongo Freight Ltd');
  assert.equal(invoice.number,'KN-71210');
});

test('carry-forward balances are omitted and separate invoices keep their own items', () => {
  const page=(page,number,amount)=>[
    'Tax invoice',`Invoice Number: ${number}`,'Description | Qty | Unit Price | Amount',
    'Brought forward | 1 | 50.00 | 50.00',`Paper | 1 | ${amount} | ${amount}`,`Total: ${amount}`
  ].map(text=>({page,text,method:'pdf-text'}));
  const result=parseExtractedText('','invoice',[...page(1,'ONE-01','12.00'),...page(2,'TWO-02','20.00')]);
  assert.equal(result.lines.length,1);
  assert.equal(result.total,12);
  assert.equal(result.additionalInvoices[0].document.total,20);
  assert.equal(result.additionalInvoices[0].firstPage,2);
  assert.throws(()=>reviewExisting(result,''),/page range \(1, 2\)/);
  const same=parseExtractedText('','invoice',[...page(1,'ONE-01','12.00'),...page(2,'ONE-01','20.00')]);
  assert.equal(same.lines.length,2);
  assert.equal(same.additionalInvoices,undefined);
});

test('sparse OCR rows sort out-of-order cells by baseline and retain page and coordinates', () => {
  const token=(text,x,y)=>({text,x,width:20,box:{x0:x,x1:x+20,y0:y,y1:y+12}});
  const rows=alignOcrRows([token('25.00',150,24),token('Paper',5,4),token('Ink',5,24),token('12.00',150,6)]
    .map(t=>({tokens:[t],page:3})));
  assert.deepEqual(rows.map(r=>r.text),['Paper  12.00','Ink  25.00']);
  assert.deepEqual(rows[0].bbox,{x0:5,y0:4,x1:170,y1:18});
  assert.equal(rows[0].page,3);
});
