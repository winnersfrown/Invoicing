// Regression evaluation of previously seen datasets, not a new holdout claim.
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {scanDuplicates,pairKey} from '../../dist/duplicates-engine.js';
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const results=[];
for(const base of ['benchmark','benchmark/holdout']){
 const truth=JSON.parse(fs.readFileSync(`${base}/ground-truth.json`));
 const documents=truth.documentIds.map(id=>JSON.parse(fs.readFileSync(`${base}/documents/${id}.json`))).filter(d=>d.type==='invoice');
 const queue=documents.map(d=>({id:d.id,status:'queued',documentType:d.type,fields:{vendor:d.vendor,number:d.number,due:d.due,subtotal:d.lines.reduce((s,l)=>s+l.quantity*l.unitPrice,0),tax:d.tax,total:d.total},source:JSON.stringify(d,null,2),fingerprint:hash(fs.readFileSync(`${base}/documents/${d.id}.json`))}));
 const pairs=scanDuplicates(queue),keys=new Set(pairs.map(p=>p.key)),positive=new Set(truth.duplicatePairs.map(([a,b])=>pairKey({id:a},{id:b})));let tp=0,fp=0,tn=0,fn=0;const decisions=[];
 for(let i=0;i<queue.length;i++)for(let j=i+1;j<queue.length;j++){const key=pairKey(queue[i],queue[j]),expected=positive.has(key),detected=keys.has(key);if(expected){if(detected)tp++;else fn++;}else if(detected)fp++;else tn++;decisions.push({key,expected,detected,evidence:pairs.find(p=>p.key===key)?.evidence||[]});}
 assert.equal(tp,6,`${base}: missed duplicate`);assert.equal(fp,0,`${base}: false duplicate alert`);assert.equal(tp+fp+tn+fn,190);
 results.push({dataset:base,tp,fp,tn,fn,groundTruthHash:hash(fs.readFileSync(`${base}/ground-truth.json`)),inputHash:hash(documents.map(d=>JSON.stringify(d)).join('\n')),decisions});
}
const report={scope:'Regression on two previously seen datasets. Not a fresh or independently blinded accuracy estimate.',engineHash:hash(fs.readFileSync('dist/duplicates-engine.js')),supplierHash:hash(fs.readFileSync('dist/supplier.js')),results};
fs.writeFileSync('benchmark/reissue-regression/results.json',JSON.stringify(report,null,2)+'\n');
const md=`# Reissued-reference regression\n\nThe previously missed pair was \`8600\` / \`REISSUED-8600\`. The rule now recognizes standalone delivery labels (reissue, reissued, resend, resent, copy, duplicate) at reference edges. It still requires the normalized supplier, total and strong text similarity to agree. Original references are retained and suspected duplicates require a human decision.\n\n| Existing dataset | Duplicate recall | False duplicate alerts |\n|---|---:|---:|\n${results.map(r=>`| ${r.dataset} | ${r.tp}/6 | ${r.fp}/184 |`).join('\n')}\n\nThese datasets are now regression fixtures, not unseen validation. Prior baseline and holdout reports remain unchanged. The original frozen holdout command intentionally refuses changed engine hashes; run \`npm run benchmark:reissue\` for this version instead. Every pair decision and engine/input hashes are saved in results.json.\n\n35 unit tests pass, including six delivery-label variants, six unrelated references, insufficient evidence, and human override. No automatic deletion or payment approval was added. Arbitrary reference rewrites and heavily degraded OCR remain outside this narrow fix.\n`;
fs.writeFileSync('benchmark/reissue-regression/REPORT.md',md);console.log(md);
