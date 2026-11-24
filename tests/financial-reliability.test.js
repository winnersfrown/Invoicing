import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseExtractedText} from '../dist/extraction.js';
import {reviewExisting, applyConfirmations} from '../dist/extraction-review.js';
import {pendingConfirmations} from '../dist/arithmetic.js';
import {compareDocuments} from '../dist/matching-engine.js';

const source=readFileSync(new URL('./fixtures/finance/rate-first.txt',import.meta.url),'utf8');
const parse=text=>parseExtractedText(text,'invoice');
const expected=[
 ['SMM-001',1,100,100],['CNT-002',5,100,500],['RPT-003',1,100,100],['IGS-004',3,50,150],['HSR-005',1,50,50]
];
for(const separator of [' ','  ',' | ']){
 test('Rate before quantity survives text fallback with delimiter '+JSON.stringify(separator),()=>{
  const doc=parse(source.replace('SKU Description Rate Qty Total',['SKU','Description','Rate','Qty','Total'].join(separator)));
  assert.deepEqual(doc.lines.map(l=>[l.sku,l.quantity,l.unitPrice,l.amount]),expected);
  assert.equal(doc.tax,null);
  assert.equal(doc.taxProposal.cents,9000);
  const confirmed=applyConfirmations(doc,{'taxes.0':90});
  const po={...confirmed,type:'purchase_order',number:'PO-810',lines:expected.map(([sku,quantity,unitPrice,amount],i)=>({sku,description:doc.lines[i].description,quantity,unitPrice,amount}))};
  assert.ok(compareDocuments(confirmed,po).lines.every(l=>l.differenceCents===0));
 });
}

test('unlabeled factors need explicit review even when multiplication agrees',()=>{
 const doc=parse('AA-1 Finishing 50 3 150');
 assert.deepEqual(pendingConfirmations(doc).map(f=>f.path),['lines.0.quantity','lines.0.unitPrice']);
 assert.throws(()=>applyConfirmations(doc,{}),/Confirm/);
 const corrected=applyConfirmations(doc,{'lines.0.quantity':3,'lines.0.unitPrice':50});
 assert.equal(corrected.lines[0].amount,150);
});

test('a missing row does not implicate the individual printed amounts',()=>{
 const rows=source.split('\n').filter(r=>!r.startsWith('HSR-')).map(text=>({text,page:1,method:'ocr',ocrConfidence:99}));
 const doc=parseExtractedText('', 'invoice', rows);
 assert.ok([...doc.arithmeticReview.contradictions,...doc.arithmeticReview.uncertain].some(c=>c.code==='printed_line_sum'&&c.differenceCents===5000));
 assert.ok(!pendingConfirmations(doc).some(f=>f.path.endsWith('.amount')));
});

test('percentage-only tax needs a supported base and printed cross-check',()=>{
 for(const [label,rate,cents] of [['VAT',15,1500],['Sales Tax:',7.5,750],['GST',5,500]]){
  const doc=parse(`Subtotal 100\n${label} ${rate}%\nTotal ${100+cents/100}`);
  assert.equal(doc.tax,null);
  assert.equal(doc.taxProposal.cents,cents);
  assert.equal(doc.extraction.fields['taxes.0'].evidence.length,3);
 }
 const rounded=parse('Subtotal 10.05\nTax: 10%\nTotal 11.06');
 assert.equal(rounded.taxProposal.cents,101);
 for(const extra of ['Tax 5%','Tax exempt','Shipping 0.00','Discount 0.00','Tax-inclusive prices']){
  const doc=parse(`Subtotal 100\nTax 10%\n${extra}\nTotal 110`);
  assert.equal(doc.taxProposal,null);
  assert.ok(pendingConfirmations(doc).some(f=>f.path==='taxes.0'));
 }
 assert.equal(parse('Subtotal 100\nTax 10%\nTotal 114').taxProposal,null);
});

test('issuer reference and adjacent title exclude buyer and order labels',()=>{
 const d=parse('TAX INVOICE Pinecrest Supply Ltd\nOur Reference: T-91\nCustomer Reference No. C-17\nPO Number PO-2');
 assert.equal(d.vendor,'Pinecrest Supply Ltd');
 assert.equal(d.number,'T-91');
 assert.equal(d.extraction.fields.number.needsConfirmation,true);
 assert.equal(parse('Invoice\nCustomer Reference No. C-12\nSales Order Number SO-42').number,'');
});

test('credit title blocks review and keeps negative amounts out of invoice checks',()=>{
 const d=parse('Credit Memo\nSupplier: Maple Ink\nTotal -100');
 assert.equal(d.type,'credit_note');
 assert.equal(d.arithmetic.length,0);
 assert.throws(()=>reviewExisting(d,''),/Credit notes are not supported/);
 assert.equal(parse('Invoice\nCredit note CN-42 applied: 5').type,'invoice');
});

test('fallback supports percentage fees and a trailing product model number',()=>{
 const d=parse('Description Days Rate Total\nConsulting 500 7.5% 37.50\nAdapter model 12 2 5.50 11');
 assert.deepEqual([d.lines[0].quantity,d.lines[0].ratePercent,d.lines[0].unitPrice,d.lines[0].amount],[500,7.5,null,37.5]);
 assert.equal(d.lines[1].description,'Adapter model 12');
});

test('grouped registration numbers never become priced rows',()=>{
 const d=parse('Terms: 30 days  VAT Reg No: GB 715 36 53\nTel: 111 223 445\nSKU Description Rate Qty Total\nAB-1 Design 35 2 70');
 assert.deepEqual(d.lines.map(l=>l.sku),['AB-1']);
});
