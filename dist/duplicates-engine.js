import {effectiveFields} from './workflow-engine.js';
import {normalizeVendor} from './supplier.js';
export {normalizeVendor} from './supplier.js';
export const normalizeReference=s=>String(s||'').toLowerCase().replace(/^(?:invoice|inv|reference|ref)[\s:#-]+/,'').replace(/[^a-z0-9]/g,'');
// Strip only standalone delivery-status labels at the edges, never arbitrary prefixes.
const deliveryLabel='(?:reissued|reissue|resent|resend|copy|duplicate)';
const referenceVariant=s=>{let value=String(s||'').trim();for(let n=0;n<4;n++){const next=value.replace(new RegExp('^'+deliveryLabel+'[\\s:#_-]+','i'),'').replace(new RegExp('[\\s:#_-]+'+deliveryLabel+'$','i'),'');if(next===value)break;value=next;}return normalizeReference(value).replace(/o/g,'0').replace(/[il]/g,'1');};
const words=s=>new Set(String(s||'').toLowerCase().match(/[a-z0-9]+/g)||[]);
export function similarity(a,b){const x=words(a),y=words(b);if(Math.min(x.size,y.size)<12)return 0;const intersection=[...x].filter(w=>y.has(w)).length;return intersection/(x.size+y.size-intersection);}
export function pairKey(a,b){return [a.id,b.id].sort().join('::');}
const documentFor=d=>d.workflow?.state==='resolved'?d.workflow.case?.revisions.at(-1)?.document:d.invoiceDocument;
const validDate=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return '';const n=Date.parse(value);return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===value?value:'';};
export function lineSignature(doc){const lines=documentFor(doc)?.lines;if(!lines?.length||!lines.every(l=>l.sku&&l.description&&Number.isFinite(l.quantity)&&Number.isFinite(l.unitPrice)))return '';return JSON.stringify(lines.map(l=>[normalizeReference(l.sku),String(l.description).toLowerCase().replace(/[^a-z0-9]/g,''),l.quantity,Math.round(l.unitPrice*100),l.amount==null?null:Math.round(l.amount*100)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));}
const fingerprintFor=d=>d.workflow?.state==='resolved'?(documentFor(d)?.fingerprint||''):d.fingerprint;
const metadata=d=>{const f=effectiveFields(d),s=documentFor(d);return {date:validDate(s?.date||f.date),currency:s?.currency||f.currency||'USD',supplierId:String(s?.supplierId||f.supplierId||'').toLowerCase().replace(/[^a-z0-9]/g,''),lines:lineSignature(d)};};
export function pairStamp(a,b){return JSON.stringify([a,b].sort((x,y)=>x.id.localeCompare(y.id)).map(d=>[d.id,effectiveFields(d),d.source,d.fingerprint,d.documentType,metadata(d)]));}
export function comparePair(a,b){
 const x=effectiveFields(a),y=effectiveFields(b);const supplier=normalizeVendor(x.vendor),ref=normalizeReference(x.number),sameSupplier=!!supplier&&supplier===normalizeVendor(y.vendor),sameRef=!!ref&&ref===normalizeReference(y.number);
 const amount=typeof x.total==='number'&&typeof y.total==='number'&&Number.isFinite(x.total)&&Number.isFinite(y.total)&&Math.round(x.total*100)===Math.round(y.total*100);const content=similarity(a.source,b.source);const evidence=[];
 const mx=metadata(a),my=metadata(b),sameDate=!!mx.date&&mx.date===my.date,dateConflict=!!mx.date&&!!my.date&&mx.date!==my.date,sameLines=!!mx.lines&&mx.lines===my.lines,sameIdentity=!!mx.supplierId&&mx.supplierId===my.supplierId,identityConflict=!!mx.supplierId&&!!my.supplierId&&mx.supplierId!==my.supplierId,currencyConflict=mx.currency!==my.currency;
 if(sameDate)evidence.push('Invoice dates agree (due dates are not used as issue dates).');
 if(dateConflict)evidence.push('Invoice dates differ; this may be a legitimate recurring purchase.');
 if(sameLines)evidence.push('Line-item signatures agree: SKU, description, quantities, prices and printed amounts.');
 if(sameIdentity)evidence.push('Explicit supplier identifiers agree.');
 if(identityConflict)evidence.push('Supplier identifiers conflict; normalized names alone cannot establish identity.');
 if(currencyConflict)evidence.push('Document currencies differ.');
 const identicalFile=!!fingerprintFor(a)&&fingerprintFor(a)===fingerprintFor(b);
 if(identicalFile)evidence.push('Identical file SHA-256 fingerprint.');
 if(sameSupplier)evidence.push('Supplier names agree after punctuation and company-suffix normalization.');
 if(sameRef)evidence.push('Invoice references agree after harmless prefix and formatting normalization.');
 if(amount)evidence.push('Document totals agree.');
 if(content>=.8)evidence.push(`Extracted content shares ${Math.round(content*100)}% of unique words (a similarity signal, not a probability).`);
 // Different nonempty references need stronger evidence than routine repeated purchases.
 const missingRef=!ref||!normalizeReference(y.number);
 const variant=!!ref&&ref!==normalizeReference(y.number)&&referenceVariant(x.number).length>=4&&referenceVariant(x.number)===referenceVariant(y.number)&&(sameSupplier||sameIdentity)&&!identityConflict&&!dateConflict&&!currencyConflict&&amount&&(content>=.9||(sameDate&&sameLines));
 if(variant)evidence.push('References differ only by a reissue/copy delivery label or common OCR character confusion; corroborating supplier, total and document evidence support human review.');
 const candidate=identicalFile||(!currencyConflict&&!identityConflict&&(variant||((sameSupplier||sameIdentity)&&sameRef)||(amount&&(sameSupplier||sameIdentity)&&missingRef&&!dateConflict&&(content>=.8||(sameDate&&sameLines)))||(amount&&sameRef&&content>=.9)));
 return {candidate,evidence,content,level:identicalFile?'Exact file':sameSupplier&&sameRef?'Strong field match':'Possible content match',key:pairKey(a,b),stamp:pairStamp(a,b),a:a.id,b:b.id};
}
export function scanDuplicates(docs){const pairs=[];for(let i=0;i<docs.length;i++)for(let j=i+1;j<docs.length;j++){const a=docs[i],b=docs[j];if(a.status==='rejected'||b.status==='rejected')continue;const p=comparePair(a,b);if(!p.candidate)continue;const decision=a.duplicateDecisions?.[p.key];if(decision?.stamp===p.stamp&&decision.action==='distinct')continue;pairs.push(p);}return pairs;}
export function duplicateIssues(doc,docs){return scanDuplicates(docs).filter(p=>p.a===doc.id||p.b===doc.id).map(p=>`Possible duplicate with ${docs.find(d=>d.id===(p.a===doc.id?p.b:p.a))?.fields.number||'missing reference'}: ${p.level}. Review in Duplicate review.`);}
export function decidePair(docs,key,action,keeper,note){const p=scanDuplicates(docs).find(p=>p.key===key);if(!p)throw Error('This pair changed. Rescan before deciding.');if(!note?.trim())throw Error('Add a reason for this decision.');if(!['distinct','duplicate'].includes(action))throw Error('Invalid decision.');if(action==='duplicate'&&![p.a,p.b].includes(keeper))throw Error('Choose a document to retain.');const decision={stamp:p.stamp,action,keeper,note:note.trim(),at:new Date().toISOString()};return docs.map(d=>{if(![p.a,p.b].includes(d.id))return d;return {...d,duplicateDecisions:{...d.duplicateDecisions,[key]:decision},...(action==='duplicate'&&d.id!==keeper?{status:'rejected',duplicateOf:keeper}:{})};});}
