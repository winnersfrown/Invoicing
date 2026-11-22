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

test('finds ruled item cells while rejecting summaries without column borders', async () => {
  const {findItemGrid}=await import('../dist/ocr-grid.js');
  const width=400,height=500;
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  const mark=(x,y)=>data.fill(0,(y*width+x)*4,(y*width+x)*4+3);
  for(const y of [100,121,150,179])for(let x=24;x<=374;x++)mark(x,y);
  assert.equal(findItemGrid({data,width,height}),null);
  for(const x of [24,210,252,310,374])for(let y=100;y<=179;y++)mark(x,y);
  const grid=findItemGrid({data,width,height});
  assert.equal(grid.rows.length,3);
  assert.equal(grid.rows[0].length,4);
  assert.equal(grid.top,100);
  assert.equal(grid.bottom,179);
});

test('partially read grid cells stay separate and unrecognized values remain blank', () => {
  const layout=[
    {text:'Invoice No: ABC-100',page:1,method:'ocr'},
    {text:'Brake pad',gridCells:{description:'Brake pad',quantity:'',unitPrice:'',amount:''},page:1,method:'ocr'},
    {text:'',gridCells:{description:'',quantity:'',unitPrice:'',amount:''},page:1,method:'ocr'},
    {text:'Total: USD 60.00',page:1,method:'ocr'}
  ];
  const doc=parseExtractedText('','invoice',layout);
  assert.equal(doc.lines.length,2);
  assert.equal(doc.lines[0].description,'Brake pad');
  assert.equal(doc.lines[0].quantity,null);
  assert.equal(doc.lines[1].amount,null);
  assert.equal(doc.extraction.fields['lines.1.amount'].support,'uncertain');
  assert.equal(doc.total,60);
});

test('preserves previous OCR values only on the overlapping physical row', async () => {
  const {keepExistingItemReads}=await import('../dist/ocr-grid.js');
  const rows=[
    {page:1,bbox:{y0:20,y1:30},text:'Paper 12',gridCells:{description:'Paper',amount:'12'}},
    {page:1,bbox:{y0:40,y1:50},text:'Pen 25',gridCells:{description:'Pen',amount:'25'}}
  ];
  const doc={lines:[{description:'Paper',quantity:2,unitPrice:6.5,amount:13}],
    extraction:{fields:{'lines.0.description':{evidence:[{page:1,bbox:{y0:22,y1:28},text:'Paper 2 6.50 13.00'}]}}}};
  keepExistingItemReads(rows,doc);
  assert.equal(rows[0].gridCells.amount,'13');
  assert.equal(rows[0].sourceRows.length,2);
  assert.equal(rows[1].gridCells.amount,'25');
});
