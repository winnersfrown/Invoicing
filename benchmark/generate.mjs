// Frozen synthetic benchmark v1. Expected outcomes are authored before execution.
import fs from 'node:fs';
const vendors=['Cedar Supply Co.','Harbor Office LLC','Maple Industrial Ltd','Orion Packaging Inc','Summit Tools Co.','Willow Studio LLC'];
const docs=[];const add=d=>(docs.push(d),d);const clone=d=>structuredClone(d);
for(let n=1;n<=6;n++)add({id:`P${n}`,type:'purchase_order',number:`PO-${n}`,poNumber:`PO-${n}`,vendor:vendors[n-1],currency:'USD',date:'2026-11-01',due:'2026-12-01',lines:[{sku:`ITEM-${n}`,description:'Standard supply carton for monthly office replenishment',quantity:10,unitPrice:50},{sku:`SHIP-${n}`,description:'Delivery handling service for scheduled warehouse shipment',quantity:1,unitPrice:20}],tax:0,total:520});
for(let n=1;n<=6;n++)add({...clone(docs[n-1]),id:`I${String(n).padStart(2,'0')}`,type:'invoice',number:`${n}004`});
const invoice=(id,base,changes)=>add({...clone(docs.find(d=>d.id===base)),id,...changes});
invoice('I07','I01',{});
invoice('I08','I02',{number:'REF 2004',vendor:'HARBOR OFFICE COMPANY'});
invoice('I09','I03',{number:''});
invoice('I10','I04',{number:'4O04'});
invoice('I11','I05',{vendor:'Summitt Tools Co.'});
invoice('I12','I06',{number:'6004-RESEND'});
invoice('I13','I01',{number:'1005',date:'2026-11-02'});
const price=invoice('I14','I02',{number:'2005',total:580});price.lines[0].unitPrice=56;
const quantity=invoice('I15','I03',{number:'3005',total:570});quantity.lines[0].quantity=11;
invoice('I16','I04',{number:'4005',total:580});
invoice('I17','I05',{number:'5005',vendor:'Unrelated Equipment LLC'});
invoice('I18','I06',{number:'6005',poNumber:'PO-999'});
const offset=invoice('I19','I01',{number:'1006'});offset.lines[0].unitPrice=51;offset.lines[1].unitPrice=10;
invoice('I20','I02',{number:'2006',tax:12,total:532});
for(let n=1;n<=4;n++)add({...clone(docs[n-1]),id:`C${n}`,type:'credit_note',number:`CN-${n}`,originalInvoiceNumber:`${n}004`,lines:[{sku:`ITEM-${n}`,description:'Credit for returned supply carton',quantity:1,unitPrice:50}],total:50});
// Positive credit amounts with explicit type; never convert a credit to a payable invoice.
for(const d of docs){d.notes='FICTIONAL BENCHMARK DOCUMENT — no payment due.';fs.writeFileSync(`benchmark/documents/${d.id}.json`,JSON.stringify(d,null,2)+'\n');fs.writeFileSync(`benchmark/documents/${d.id}.txt`,`${d.type.toUpperCase()}\nVendor: ${d.vendor}\nReference: ${d.number||'[missing]'}\nPO: ${d.poNumber}\nDate: ${d.date}\nDue: ${d.due}\n${d.lines.map((l,i)=>`Line ${i+1}: ${l.sku} | ${l.description} | ${l.quantity} x $${l.unitPrice.toFixed(2)} = $${(l.quantity*l.unitPrice).toFixed(2)}`).join('\n')}\nTax: $${d.tax.toFixed(2)}\nTotal: $${d.total.toFixed(2)} USD\n${d.originalInvoiceNumber?'Credits invoice: '+d.originalInvoiceNumber+'\n':''}${d.notes}\n`);}
const scenarios=Array.from({length:20},(_,i)=>({invoice:`I${String(i+1).padStart(2,'0')}`,po:`P${i<6?i+1:i<12?i-5:[1,2,3,4,5,6,1,2][i-12]}`,expected:'matched',reason:'All ordered amounts agree.'}));
const set=(n,x)=>Object.assign(scenarios[n-1],x);
set(8,{reason:'Verified supplier alias represents the same synthetic supplier; prefix is harmless.'});
set(9,{expected:'invalid_reference',reason:'Missing invoice reference must block comparison.'});
set(11,{reason:'Synthetic supplier typo represents the same supplier (master identity ground truth).'});
set(14,{expected:'discrepancy',difference:6000,lines:[{sku:'ITEM-2',difference:6000,invoiceLine:1,poLine:1,invoicePrice:56,poPrice:50,invoiceQty:10,poQty:10}],draft:['10 × $56.00','10 × $50.00','$60.00'],reason:'Ten units overcharged $6 each.'});
set(15,{expected:'discrepancy',difference:5000,lines:[{sku:'ITEM-3',difference:5000,invoiceLine:1,poLine:1,invoicePrice:50,poPrice:50,invoiceQty:11,poQty:10}],draft:['11 × $50.00','10 × $50.00','$50.00'],reason:'One extra unit billed.'});
set(16,{expected:'invalid_total',error:['line amounts + tax','document total'],reason:'Stated total 580 disagrees with computed 520.'});
set(17,{expected:'vendor_mismatch',error:['Vendor mismatch'],reason:'Invoice belongs to a genuinely different supplier.'});
set(18,{expected:'po_mismatch',error:['reference mismatch'],reason:'Invoice references a different PO.'});
set(19,{expected:'discrepancy',difference:0,lines:[{sku:'ITEM-1',difference:1000,invoiceLine:1,poLine:1,invoicePrice:51,poPrice:50,invoiceQty:10,poQty:10},{sku:'SHIP-1',difference:-1000,invoiceLine:2,poLine:2,invoicePrice:10,poPrice:20,invoiceQty:1,poQty:1}],draft:['$10.00','-$10.00','10 × $51.00','1 × $10.00'],reason:'Offsetting line errors must not be hidden by a zero net difference.'});
set(20,{expected:'discrepancy',difference:1200,lines:[],taxDifference:1200,draft:['Tax: invoice $12.00; PO $0.00','$12.00'],reason:'Unordered tax charge.'});
set(9,{error:['number']});
fs.writeFileSync('benchmark/ground-truth.json',JSON.stringify({version:1,seed:'deterministic-no-randomness',documentIds:docs.map(d=>d.id),duplicatePairs:[['I01','I07'],['I02','I08'],['I03','I09'],['I04','I10'],['I05','I11'],['I06','I12']],scenarios,credits:['C1','C2','C3','C4'],creditExpectation:'Explicitly reject unsupported credit notes without treating them as payable invoices.'},null,2)+'\n');
console.log('Created 30 documents: 20 invoices, 6 purchase orders, 4 credit notes (JSON + readable text representations).');
