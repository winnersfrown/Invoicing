import {normalizeVendor} from './supplier.js';
export {normalizeVendor} from './supplier.js';
export const normalizeReference=s=>String(s||'').toLowerCase().replace(/^(?:invoice|inv|reference|ref)[\s:#-]+/,'').replace(/[^a-z0-9]/g,'');
// Strip only standalone delivery-status labels at the edges, never arbitrary prefixes.
const deliveryLabel='(?:reissued|reissue|resent|resend|copy|duplicate)';
const referenceVariant=s=>{let value=String(s||'').trim();for(let n=0;n<4;n++){const next=value.replace(new RegExp('^'+deliveryLabel+'[\\s:#_-]+','i'),'').replace(new RegExp('[\\s:#_-]+'+deliveryLabel+'$','i'),'');if(next===value)break;value=next;}return normalizeReference(value).replace(/o/g,'0').replace(/[il]/g,'1');};
const words=s=>new Set(String(s||'').toLowerCase().match(/[a-z0-9]+/g)||[]);
export function similarity(a,b){const x=words(a),y=words(b);if(Math.min(x.size,y.size)<12)return 0;const intersection=[...x].filter(w=>y.has(w)).length;return intersection/(x.size+y.size-intersection);}
export function pairKey(a,b){return [a.id,b.id].sort().join('::');}
export function pairStamp(a,b){return JSON.stringify([a,b].sort((x,y)=>x.id.localeCompare(y.id)).map(d=>[d.id,d.fields,d.source,d.fingerprint,d.documentType]));}
export function comparePair(a,b){
 const x=a.fields,y=b.fields;const supplier=normalizeVendor(x.vendor),ref=normalizeReference(x.number),sameSupplier=!!supplier&&supplier===normalizeVendor(y.vendor),sameRef=!!ref&&ref===normalizeReference(y.number);
 const amount=typeof x.total==='number'&&typeof y.total==='number'&&Number.isFinite(x.total)&&Number.isFinite(y.total)&&Math.round(x.total*100)===Math.round(y.total*100);const content=similarity(a.source,b.source);const evidence=[];
 const identicalFile=!!a.fingerprint&&a.fingerprint===b.fingerprint;
 if(identicalFile)evidence.push('Identical file SHA-256 fingerprint.');
 if(sameSupplier)evidence.push('Supplier names agree after punctuation and company-suffix normalization.');
 if(sameRef)evidence.push('Invoice references agree after harmless prefix and formatting normalization.');
 if(amount)evidence.push('Document totals agree.');
 if(content>=.8)evidence.push(`Extracted content shares ${Math.round(content*100)}% of unique words (a similarity signal, not a probability).`);
 // Different nonempty references need stronger evidence than routine repeated purchases.
 const missingRef=!ref||!normalizeReference(y.number);
 const variant=!!ref&&ref!==normalizeReference(y.number)&&referenceVariant(x.number).length>=4&&referenceVariant(x.number)===referenceVariant(y.number)&&sameSupplier&&amount&&content>=.9;
 if(variant)evidence.push('References differ only by a reissue/copy delivery label or common OCR character confusion; matching supplier, total and content support human review.');
 const candidate=variant||identicalFile||(sameSupplier&&sameRef)||(amount&&sameSupplier&&missingRef&&content>=.8)||(amount&&sameRef&&content>=.9);
 return {candidate,evidence,content,level:identicalFile?'Exact file':sameSupplier&&sameRef?'Strong field match':'Possible content match',key:pairKey(a,b),stamp:pairStamp(a,b),a:a.id,b:b.id};
}
export function scanDuplicates(docs){const pairs=[];for(let i=0;i<docs.length;i++)for(let j=i+1;j<docs.length;j++){const a=docs[i],b=docs[j];if(a.status==='rejected'||b.status==='rejected')continue;const p=comparePair(a,b);if(!p.candidate)continue;const decision=a.duplicateDecisions?.[p.key];if(decision?.stamp===p.stamp&&decision.action==='distinct')continue;pairs.push(p);}return pairs;}
export function duplicateIssues(doc,docs){return scanDuplicates(docs).filter(p=>p.a===doc.id||p.b===doc.id).map(p=>`Possible duplicate with ${docs.find(d=>d.id===(p.a===doc.id?p.b:p.a))?.fields.number||'missing reference'}: ${p.level}. Review in Duplicate review.`);}
export function decidePair(docs,key,action,keeper,note){const p=scanDuplicates(docs).find(p=>p.key===key);if(!p)throw Error('This pair changed. Rescan before deciding.');if(!note?.trim())throw Error('Add a reason for this decision.');if(!['distinct','duplicate'].includes(action))throw Error('Invalid decision.');if(action==='duplicate'&&![p.a,p.b].includes(keeper))throw Error('Choose a document to retain.');const decision={stamp:p.stamp,action,keeper,note:note.trim(),at:new Date().toISOString()};return docs.map(d=>{if(![p.a,p.b].includes(d.id))return d;return {...d,duplicateDecisions:{...d.duplicateDecisions,[key]:decision},...(action==='duplicate'&&d.id!==keeper?{status:'rejected',duplicateOf:keeper}:{})};});}
