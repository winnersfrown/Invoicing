import test from 'node:test';
import assert from 'node:assert/strict';
import {groupPdfRows, parseLayoutText} from '../dist/layout-extraction.js';

const parse = text => parseLayoutText(text, 'invoice');
const pdfItem = (str, x, y) => ({str, width: str.length * 5, transform: [1,0,0,1,x,y]});
test('two-column invoice from the reported review screen', () => {
  const items = [
    ['Invoice',330,700], ['Billed to:',40,650], ['Invoice No.',325,650], ['12345',384,650],
    ['Estelle Darcy',40,635], ['30 July 2025',325,635], ['Total',275,300], ['$957',365,300],
    ['Account Name: Juliana Silva',40,100], ['Juliana Silva',330,100]
  ];
  const d = parseLayoutText('', 'invoice', groupPdfRows(items.map(args => pdfItem(...args))));
  assert.equal(d.number, '12345');
  assert.equal(d.vendor, 'Juliana Silva');
  assert.equal(d.extraction.fields.vendor.support, 'uncertain');
  assert.match(d.extraction.fields.vendor.reason, /recipient/);
  assert.equal(d.poNumber, '');
  assert.equal(d.currency, '');
  assert.match(d.extraction.fields.currency.reason, /symbol/);
  assert.match(d.extraction.fields.number.evidence[0].text, /Invoice No/);
  assert.equal(d.total, 957);
});
test('OCR with collapsed columns keeps adjacent labels separate and preserves its evidence', () => {
  const rows = ['Billed to: Invoice No. 12345', 'Supplier Name: Atlas Paper PO Ref. PO-007 Currency Code: cad']
    .map(text => ({text, page:2, method:'ocr', ocrConfidence:67}));
  const d = parseLayoutText('', 'invoice', rows);
  assert.deepEqual([d.vendor,d.number,d.poNumber,d.currency],['Atlas Paper','12345','PO-007','CAD']);
  assert.equal(d.extraction.fields.currency.support,'uncertain');
  assert.equal(d.extraction.fields.vendor.evidence[0].page,2);
});
test('stacked labels read the value underneath in the same column', () => {
  const items = [['Supplier Name',20,600],['PO Number',330,600],['Atlas Paper',20,580],['PO-88',330,580]];
  const d = parseLayoutText('', 'invoice', groupPdfRows(items.map(args=>pdfItem(...args))));
  assert.equal(d.vendor,'Atlas Paper');
  assert.equal(d.poNumber,'PO-88');
  assert.match(d.extraction.fields.poNumber.evidence[0].text,/PO-88/);
});
test('buyer, PO placeholders and ambiguous money symbols never become issuer, PO or ISO code', () => {
  const d=parse('Billed to:\nCustomer Services LLC\nInvoice No. 00123\nPO reference: N/A\nTotal: $123');
  assert.deepEqual([d.vendor,d.number,d.poNumber,d.currency],['','00123','','']);
});
test('explicit supplier takes precedence over a separate payee and lower-case currency normalizes', () => {
  const d=parse('Account holder: Factoring Partners\nVendor Name: Actual Supplier Ltd\nCurrency: usd');
  assert.equal(d.vendor,'Actual Supplier Ltd');
  assert.equal(d.extraction.fields.vendor.support,'supported');
  assert.equal(d.currency,'USD');
});
test('monetary codes, regional symbols and printed PO references', () => {
  for (const [text,code] of [['Amount due: 100.00 CAD','CAD'],['Total (EUR): 100','EUR'],['Total: US$100','USD'],['Total: A$100','AUD']]) assert.equal(parse(text).currency,code);
  assert.equal(parse('Invoice No.12345\nPurchase Order No.: PO-9').number,'12345');
  assert.equal(parse('Invoice: INV-1\nP.O. # PO-9').poNumber,'PO-9');
  assert.equal(parseLayoutText('Purchase order\nPO-77','purchase_order').number,'PO-77');
  assert.equal(parse('Invoice INV-8').number,'INV-8');
});

test('contradictory currency codes stay reviewable with both source passages', () => {
  const d=parse('Currency: USD\nTotal (CAD): 100.00');
  assert.equal(d.extraction.fields.currency.support,'uncertain');
  assert.equal(d.extraction.fields.currency.evidence.length,2);
});
test('signed-in ingestion retains source-supported currency and flags a suggested payee', async () => {
  const {extractedInvoice}=await import('../dist/server-inbox.js');
  const read=parse('Billed to: Invoice No. 12345\nAccount Name: Juliana Silva\nPO Ref: PO-9\nTotal: CA$957');
  const out=extractedInvoice({method:'ocr',read,final:structuredClone(read)});
  assert.equal(out.currency,'CAD');
  assert.equal(out.extraction.field_confidence.currency,1);
  assert.ok(out.extraction.uncertain.includes('supplier_name'));
  assert.equal(out.po_reference,'PO-9');
});

test('two-column image OCR reads customer and dates and keeps item descriptions out of the SKU field', async () => {
  const {invoiceDateIssue} = await import('../dist/invoice-dates.js');
  const rows = [
    [['Billed to:',116],['Invoice No. 12345',828]],
    [['Example Customer',116],['30]uly 2025',880]],
    [['Item',116],['Quantity',532],['Unit Price',690],['Total',921]],
    [['White',113],['Basic',183],['Tank',242],['Top',299],['2',532],['$80',690],['160',942]],
    [['Denim Jacket',113],['1',531],['$320',688],['320',941]],
    [['Bamboo Underwear',113],['3',529],['$50',688],['150',942]],
    [['Striped Pants',114],['1',533],['$240',690],['240',941]],
    [['Subtotal',689],['870',941]], [['Tax (10%)',687],['$87',939]], [['Total',689],['$957',922]],
    [['Account Name: Example Supplier',114]], [['Pay by: 10 July 2025',116]]
  ].map(cells => ({text: cells.map(([text])=>text).join(' '), page:1, method:'ocr', ocrConfidence:95,
    tokens:cells.map(([text,x])=>({text,x,width:text.length*11}))}));
  const d=parseLayoutText('', 'invoice', rows);
  assert.deepEqual([d.vendor,d.customer,d.number,d.poNumber,d.date,d.due],['Example Supplier','Example Customer','12345','','2025-07-30','2025-07-10']);
  assert.deepEqual(d.lines.map(l=>[l.sku,l.description,l.quantity,l.unitPrice,l.amount]),[
    ['','White Basic Tank Top',2,80,160], ['','Denim Jacket',1,320,320],
    ['','Bamboo Underwear',3,50,150], ['','Striped Pants',1,240,240]
  ]);
  assert.deepEqual([d.subtotal,d.taxRate,d.tax,d.total,d.arithmetic],[870,10,87,957,[]]);
  assert.match(invoiceDateIssue(d.date,d.due), /20 days before invoice date/);
});

test('date check accepts same-day terms, ignores missing or invalid dates, and tracks edits', async () => {
  const {invoiceDateIssue,readInvoiceDate}=await import('../dist/invoice-dates.js');
  const {issuesFor}=await import('../dist/engine.js');
  assert.equal(readInvoiceDate('July 30, 2025').value,'2025-07-30');
  assert.equal(readInvoiceDate('31 February 2025'),null);
  assert.deepEqual(readInvoiceDate('30]uly 2025','ocr'),{value:'2025-07-30',uncertain:true});
  assert.equal(readInvoiceDate('30]uly 2025','pdf-text'),null);
  assert.equal(invoiceDateIssue('2025-07-30','2025-07-30'),'');
  assert.equal(invoiceDateIssue('', '2025-07-10'),'');
  const doc={id:'test',fields:{vendor:'Example',number:'INV-10',date:'2025-07-30',due:'2025-07-10',subtotal:870,tax:87,total:957}};
  assert.match(issuesFor(doc,[doc]).join(' '), /20 days before invoice date/);
  doc.fields.due='2025-07-31';
  assert.deepEqual(issuesFor(doc,[doc]),[]);
});
