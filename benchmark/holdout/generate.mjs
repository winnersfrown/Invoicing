// Fresh scenarios authored AFTER engine-freeze.json. No production tuning after evaluation.
import fs from 'node:fs';
const out='benchmark/holdout',docs=[];const vendors=['Birch Laboratory LLC','Cobalt Hardware Inc','Linden Catering Ltd','Meadow Textile Co.','Quartz Fixtures LLC','Spruce Print Company'];
for(let n=1;n<=6;n++)docs.push({id:`P${n}`,type:'purchase_order',number:`ORDER-${70+n}`,poNumber:`ORDER-${70+n}`,vendor:vendors[n-1],currency:'USD',date:'2026-11-13',due:'2026-12-13',lines:[{sku:`KIT-${n}`,description:'Workshop assembly kit with sealed components and inspection label',quantity:4,unitPrice:72.25},{sku:`PACK-${n}`,description:'Protective packing and scheduled delivery to regional distribution depot',quantity:3,unitPrice:8.5}],tax:14.5,total:329});
for(let n=1;n<=6;n++)docs.push({...structuredClone(docs[n-1]),id:`I${String(n).padStart(2,'0')}`,type:'invoice',number:`8${n}00`});
const get=id=>docs.find(d=>d.id===id),add=(id,base,changes={})=>{const d={...structuredClone(get(base)),id,...changes};docs.push(d);return d;};
add('I07','I01',{number:'8100 COPY'});add('I08','I02',{number:'82O0'});add('I09','I03',{number:''});add('I10','I04',{vendor:'MEADOW TEXTILE CORPORATION',number:'INV 8400'});add('I11','I05');add('I12','I06',{number:'REISSUED-8600'});
add('I13','I01',{number:'8101',date:'2026-11-14'});
const price=add('I14','I02',{number:'8201',total:338});price.lines[0].unitPrice=74.5;
const missing=add('I15','I03',{number:'8301',total:303.5});missing.lines.pop();
add('I16','I04',{number:'8401',total:330});add('I17','I05',{number:'8501',vendor:'Different Fittings Inc'});add('I18','I06',{number:'8601',poNumber:'ORDER-999'});
const offset=add('I19','I01',{number:'8102'});offset.lines[0].unitPrice=73;offset.lines[1].unitPrice=7.5;
add('I20','I02',{number:'8202',vendor:'Cobaltt Hardware Inc'});
for(let n=1;n<=4;n++)docs.push({...structuredClone(get(`P${n}`)),id:`C${n}`,type:'credit_note',number:`CREDIT-${91+n}`,originalInvoiceNumber:`8${n}00`,lines:[{sku:`KIT-${n}`,description:'Return of one damaged assembly kit',quantity:1,unitPrice:72.25}],tax:0,total:72.25});
for(const d of docs){d.notes='Fictional holdout document. No actual obligation.';fs.writeFileSync(`${out}/documents/${d.id}.json`,JSON.stringify(d,null,2)+'\n');fs.writeFileSync(`${out}/documents/${d.id}.txt`,`${d.type}\nSupplier: ${d.vendor}\nReference: ${d.number||'[missing]'}\nPO: ${d.poNumber}\n${d.lines.map((l,i)=>`${i+1}. ${l.sku} ${l.description}: ${l.quantity} x ${l.unitPrice}`).join('\n')}\nTax: ${d.tax}\nTotal: ${d.total} USD\n${d.notes}\n`);}
const scenarios=Array.from({length:20},(_,i)=>({invoice:`I${String(i+1).padStart(2,'0')}`,po:`P${i<6?i+1:i<12?i-5:[1,2,3,4,5,6,1,2][i-12]}`,expected:'matched',reason:'Amounts agree with PO; supplier identity is the same in fictional master records.'}));
const set=(n,x)=>Object.assign(scenarios[n-1],x);
set(9,{expected:'invalid_reference',error:['number'],reason:'Invoice reference missing.'});
set(14,{expected:'discrepancy',difference:900,lines:[{sku:'KIT-2',difference:900,invoiceLine:1,poLine:1,invoicePrice:74.5,poPrice:72.25,invoiceQty:4,poQty:4}],draft:['4 × $74.50','4 × $72.25','$9.00'],reason:'Four units priced $2.25 above PO.'});
set(15,{expected:'discrepancy',difference:-2550,lines:[{sku:'PACK-3',difference:-2550,invoiceLine:null,poLine:2,invoicePrice:null,poPrice:8.5,invoiceQty:null,poQty:3}],draft:['invoice line missing','PO line 2','-$25.50'],reason:'Packing line omitted from invoice.'});
set(16,{expected:'invalid_total',error:['line amounts + tax','document total'],reason:'Declared total is $1 too high.'});set(17,{expected:'vendor_mismatch',error:['Vendor mismatch'],reason:'Different supplier.'});set(18,{expected:'po_mismatch',error:['reference mismatch'],reason:'Wrong PO reference.'});
set(19,{expected:'discrepancy',difference:0,lines:[{sku:'KIT-1',difference:300,invoiceLine:1,poLine:1,invoicePrice:73,poPrice:72.25,invoiceQty:4,poQty:4},{sku:'PACK-1',difference:-300,invoiceLine:2,poLine:2,invoicePrice:7.5,poPrice:8.5,invoiceQty:3,poQty:3}],draft:['$3.00','-$3.00','4 × $73.00','3 × $7.50'],reason:'Offsetting charges with unchanged invoice total.'});
fs.writeFileSync(`${out}/ground-truth.json`,JSON.stringify({version:1,documentIds:docs.map(d=>d.id),duplicatePairs:[['I01','I07'],['I02','I08'],['I03','I09'],['I04','I10'],['I05','I11'],['I06','I12']],scenarios,credits:['C1','C2','C3','C4']},null,2)+'\n');
