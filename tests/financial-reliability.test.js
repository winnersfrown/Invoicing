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

test('regrouped high-confidence OCR exposes a subtotal gap and weak words stay uncertain',async()=>{
 const {alignOcrRows}=await import('../dist/ocr-layout.js');
 const words=(texts,y)=>texts.map(([text,x,confidence=95])=>({text,x,width:22,confidence,box:{x0:x,x1:x+22,y0:y,y1:y+9}}));
 const samples=[[['Description',0],['Rate',180],['Qty',260],['Amount',360]],
  [['Widget',0],['12',180],['5',260],['60',360]],[['Kit',0],['13',180],['1',260],['13',360]],
  [['Subtotal',200],['76',360]]];
 const read=()=>parseExtractedText('','invoice',alignOcrRows(samples.map((r,i)=>({page:1,tokens:words(r,i*15)}))));
 assert.ok(read().arithmetic.some(c=>c.code==='printed_line_sum'&&c.differenceCents===300));
 samples[3][1][2]=45;
 assert.ok(read().arithmeticReview.uncertain.some(c=>c.code==='printed_line_sum'&&c.differenceCents===300));
});

test('separate tax rates with unprinted bases leave allocation open and preserve total checks',()=>{
 const body='Subtotal 100\nGST 5% 3.00\nPST 10% 4.00\nTotal ';
 const d=parse(body+'107');
 assert.deepEqual(d.arithmetic,[]);
 assert.equal(d.arithmeticReview.uncertain.filter(c=>c.code==='tax_rate'&&c.expectedCents===null).length,2);
 assert.ok(parse(body+'110').arithmetic.some(c=>c.code==='displayed_total'));
});

test('incomplete aligned rows retain the printed price and amount for mandatory line review',async()=>{
 const {lineReviewReasons}=await import('../dist/extraction-validation.js');
 const header=[['Description',10],['Rate',180],['Qty',260],['Amount',360]];
 const data=[['Binding 24',10],['33.50',180],['?',260],['67.00',360]];
 const rows=[header,data].map(c=>({text:c.map(([t])=>t).join(' '),method:'ocr',page:1,
  tokens:c.map(([text,x])=>({text,x,width:25})),ocrConfidence:93}));
 const doc=parseExtractedText('','invoice',rows);
 assert.deepEqual(doc.lines,[{description:'Binding 24',sku:'',unitPrice:33.5,quantity:null,amount:67}]);
 assert.match(lineReviewReasons(doc)[0],/quantity/);
 const broken=structuredClone(rows);
 broken[1].tokens[1].text='illegible';
 broken[1].text=broken[1].tokens.map(t=>t.text).join(' ');
 const partial=parseExtractedText('','invoice',broken);
 assert.deepEqual(partial.lines,[{description:'Binding 24',sku:'',unitPrice:null,quantity:null,amount:67}]);
 assert.match(lineReviewReasons(partial)[0],/quantity or basis, price or rate/);
 assert.match(lineReviewReasons(parse('Total 9'))[0],/No line items/);
 assert.match(lineReviewReasons(parse('Description Qty Rate Amount\nBox 2 4 8\nSubtotal 10'))[0],/line sum/);
});
