import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {compareDocuments,validateDocument,correctionDraft,reviewedExport,reviewCsv} from '../dist/matching-engine.js';
const pair=()=>['matching-invoice','matching-po'].map(n=>JSON.parse(readFileSync(new URL('../dist/samples/'+n+'.json',import.meta.url))));
test('computes $60 mismatch from source line prices and quantities',()=>{const [i,p]=pair(),r=compareDocuments(i,p);assert.equal(r.differenceCents,6000);assert.equal(r.lines[0].differenceCents,6000);assert.equal(r.lines[0].invoiceLine,1);assert.equal(r.lines[0].poLine,1);assert.equal(r.lines[1].changed,false);assert.match(correctionDraft(i,p,r),/12 × \$45.00/);assert.match(correctionDraft(i,p,r),/12 × \$40.00/);});
test('review gate and payment hold survive CSV and JSON export',()=>{const [i,p]=pair(),r=compareDocuments(i,p);assert.throws(()=>reviewedExport(i,p,r,false));const data=reviewedExport(i,p,r,true);assert.equal(data.paymentStatus,'ON_HOLD');assert.equal(data.paymentApproved,false);assert.equal(data.resolutionStatus,'awaiting_vendor_correction');assert.match(reviewCsv(data),/ON_HOLD/);assert.equal(i.total,660);});
test('matching documents still require human payment approval',()=>{const [i,p]=pair();i.lines[0].unitPrice=40;i.total=600;const r=compareDocuments(i,p);assert.equal(r.hasDiscrepancy,false);assert.equal(reviewedExport(i,p,r,true).paymentStatus,'NOT_APPROVED');});
test('rejects malformed documents, invalid amounts and wrong reference',()=>{const [i,p]=pair();assert.throws(()=>validateDocument({},'invoice'));assert.equal(validateDocument({...i,total:650},'invoice').total,650);assert.ok(compareDocuments({...i,total:650},p).arithmetic.length);assert.throws(()=>compareDocuments({...i,poNumber:'WRONG'},p));assert.throws(()=>compareDocuments({...i,vendor:'Other'},p));assert.throws(()=>compareDocuments({...i,currency:'EUR'},p));i.lines[0].quantity=-1;assert.throws(()=>validateDocument(i,'invoice'));});
test('zero net difference does not hide offsetting price changes',()=>{const [i,p]=pair();i.lines[1].unitPrice=15;i.total=600;const r=compareDocuments(i,p);assert.equal(r.differenceCents,0);assert.equal(r.hasDiscrepancy,true);assert.equal(reviewedExport(i,p,r,true).paymentStatus,'ON_HOLD');});
test('missing SKU is evidenced and duplicate SKU rejected',()=>{const [i,p]=pair();i.lines.splice(1,1);i.total=540;let r=compareDocuments(i,p);assert.equal(r.lines[1].invoiceLine,null);assert.equal(r.lines[1].changed,true);i.lines.push({...i.lines[0]});i.total=1080;assert.throws(()=>validateDocument(i,'invoice'));});

test('exact SKUs take precedence and only an explicit decision pairs different SKUs', () => {
 const [invoice, po] = pair();
 invoice.lines[0].sku = ' paper-a4 ';
 invoice.lines[1].sku = 'FLDR-20';
 const pending = compareDocuments(invoice, po);
 assert.equal(pending.lines[0].matchBasis, 'exact_sku');
 assert.equal(pending.lines[0].differenceCents, 6000);
 assert.deepEqual(pending.pendingLineMatches, [{invoiceLine: 2, poLine: 2, description: 'same', sameQuantity: true}]);
 assert.throws(() => reviewedExport(invoice, po, pending, true), /product and amount review/);
 const result = compareDocuments(invoice, po, {lineDecisions: [{invoiceLine: 2, poLine: 2, decision: 'confirm'}]});
 assert.equal(result.lines[1].matchBasis, 'reviewer_confirmed');
 assert.equal(result.pendingLineMatches.length, 0);
 assert.equal(result.lines[1].changed, false);
});

test('a rejected pair remains unmatched and different printed dimensions rule out a suggestion', () => {
 const [invoice, po] = pair();
 invoice.lines[1].sku = 'BAN-002';
 po.lines[1].sku = 'BN-002';
 invoice.lines[1].description = 'Banner (2x6m)';
 po.lines[1].description = 'Banner (2x8m)';
 const unrelated = compareDocuments(invoice, po);
 assert.equal(unrelated.pendingLineMatches.length, 0);
 assert.equal(unrelated.lines.filter(line => line.matchBasis === 'unmatched').length, 2);
 po.lines[1].description = 'Banner (2x6m)';
 const rejected = compareDocuments(invoice, po, {lineDecisions: [{invoiceLine: 2, poLine: 2, decision: 'reject'}]});
 assert.equal(rejected.pendingLineMatches.length, 0);
 assert.equal(rejected.lines.filter(line => line.matchBasis === 'unmatched').length, 2);
});
