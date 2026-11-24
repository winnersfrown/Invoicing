// Run from the repository root with TESSERACT_CACHE pointing to eng.traineddata.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract from 'tesseract.js';
import {parseExtractedText} from '../../../dist/extraction.js';
import {groupPdfRows} from '../../../dist/layout-extraction.js';
import {ocrRows} from '../../../dist/ocr-layout.js';
import {pendingConfirmations} from '../../../dist/arithmetic.js';

const dir=new URL('./',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,dir));
const sha=data=>createHash('sha256').update(data).digest('hex');
const answers=JSON.parse(read('answers.json'));
const followup=process.argv.includes('--followup');
const freeze=JSON.parse(read(followup?'../../holdout/engine-freeze.v8.json':'../../holdout/engine-freeze.v7.json'));
for(const [file,hash] of Object.entries(freeze))assert.equal(sha(fs.readFileSync(file)),hash,file);
const results=[];
let worker;
async function extract(bytes,file,kind){
 const parse=rows=>parseExtractedText(rows.map(r=>r.text).join('\n'),kind,rows);
 if(file.endsWith('.pdf')){
  const pdf=await getDocument({data:new Uint8Array(bytes),useSystemFonts:true,verbosity:0}).promise;
  try{return parse(groupPdfRows((await (await pdf.getPage(1)).getTextContent()).items));}
  finally {await pdf.destroy();}
 }
 worker??=await Tesseract.createWorker('eng',1,{cachePath:process.env.TESSERACT_CACHE});
 for(const mode of ['3','6']){
  await worker.setParameters({tessedit_pageseg_mode:mode});
  const d=parse(ocrRows((await worker.recognize(bytes,{}, {text:true,blocks:true})).data,1));
  if(d.total!=null || mode==='6')return d;
 }
}
const keys=['sku','description','quantity','unitPrice','amount'];
for(const key of answers){
 const bytes=read('documents/'+key.file);
 const row={file:key.file,sha256:sha(bytes),scenario:key.scenario,kind:key.kind,expectedLines:key.lines.length};
 const start=performance.now();
 try{
  const d=await extract(bytes,key.file,key.kind==='purchase_order'?'purchase_order':'invoice');
  const confirmed=pendingConfirmations(d);
  const eligible=key.kind!=='credit_note';
  row.kindCorrect=d.type===key.kind;
  row.blocked=Boolean(d.unsupportedReason);
  if(eligible){
   row.extractedLines=d.lines.length;
   row.headers={number:(d.number||null)===key.number,supplier:d.vendor===key.supplier,currency:d.currency===key.currency,
    subtotal:d.subtotal===key.subtotal,tax:d.tax===key.printedTax,total:d.total===key.total};
   row.lineFields=Object.fromEntries(keys.map(k=>[k,key.lines.filter((e,i)=>e[k]===d.lines[i]?.[k]).length]));
   row.pending=confirmed.map(p=>p.path);
   row.swaps=0;row.silentSwaps=0;
   key.lines.forEach((e,i)=>{
    const got=d.lines[i];
    if(e.quantity!==e.unitPrice&&got?.quantity===e.unitPrice&&got?.unitPrice===e.quantity){
     row.swaps++;
     if(!confirmed.some(p=>p.path===`lines.${i}.quantity`||p.path===`lines.${i}.unitPrice`))row.silentSwaps++;
    }
   });
   row.ambiguous=key.ambiguous;
   row.ambiguousFlagged=key.ambiguous&&confirmed.some(p=>p.path.endsWith('.quantity'));
   row.expectedDiscrepancy=key.discrepancy;
   row.flagged=Boolean(d.arithmetic.length);
   row.taxProposalExpected=key.proposedTax;
   row.taxProposal=d.taxProposal?.cents==null?null:d.taxProposal.cents/100;
   // Count incorrect numeric alternatives offered for printed financial amounts.
   // Candidate assignments of quantity and rate are measured separately.
   row.falseAmountCandidates=[];
   for(const p of confirmed){
    const line=p.path.match(/^lines\.(\d+)\.amount$/);
    const truth=line?key.lines[Number(line[1])]?.amount:p.path==='total'?key.total:p.path==='subtotal'?key.subtotal:undefined;
    if(truth!=null)for(const c of p.candidates)if(c.value!==truth&&c.value!==p.value)row.falseAmountCandidates.push({path:p.path,value:c.value,truth});
   }
  }
 }catch(e){row.error=String(e.message);}
 row.ms=Math.round(performance.now()-start);
 results.push(row);
}
if(worker)await worker.terminate();
const scored=results.filter(r=>r.kind!=='credit_note');
const count=predicate=>scored.filter(predicate).length;
const sum=fn=>scored.reduce((s,r)=>s+fn(r),0);
const summary={documents:results.length,errors:results.filter(r=>r.error).length,productDocuments:scored.length,
 lines:sum(r=>r.expectedLines),lineFields:Object.fromEntries(keys.map(k=>[k,sum(r=>r.lineFields?.[k]??0)])),
 headers:Object.fromEntries(['number','supplier','currency','subtotal','tax','total'].map(k=>[k,count(r=>r.headers?.[k])])),
 swaps:sum(r=>r.swaps??0),silentSwaps:sum(r=>r.silentSwaps??0),pendingDocuments:count(r=>r.pending?.length),
 ambiguousFlagged:count(r=>r.ambiguousFlagged),ambiguousCases:answers.filter(k=>k.ambiguous).length,
 genuineFlagged:count(r=>r.expectedDiscrepancy&&r.flagged),genuineCases:answers.filter(k=>k.discrepancy).length,
 falseAlarms:count(r=>!r.expectedDiscrepancy&&r.flagged),incorrectAmountAlternatives:sum(r=>r.falseAmountCandidates?.length??0),
 creditsBlocked:results.filter(r=>r.kind==='credit_note'&&r.blocked).length,credits:answers.filter(k=>k.kind==='credit_note').length,
 proposedTaxCorrect:count(r=>r.taxProposalExpected!=null&&r.taxProposal===r.taxProposalExpected),taxProposalsExpected:answers.filter(k=>k.proposedTax!=null).length,
 ms:results.reduce((s,r)=>s+r.ms,0)};
fs.writeFileSync(new URL(followup?'../followup/results.json':'results.json',dir),JSON.stringify({freeze,answerKeySha256:sha(read('answers.json')),summary,results},null,2)+'\n');
console.log(summary);
