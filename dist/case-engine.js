import {compareDocuments,correctionDraft} from './matching-engine.js';
import {arithmeticReview,correctField,pathValue} from './arithmetic.js';
export function newCase(invoice,po){const comparison=compareDocuments(invoice,po);return {id:'case-'+invoice.number,original:structuredClone(invoice),po:structuredClone(po),comparison,revisions:[],status:comparison.hasDiscrepancy?'open':'matched',draft:'',events:[{at:new Date().toISOString(),action:'Case opened',detail:`Original invoice ${invoice.number} compared with ${po.number}.`}],paymentApproved:false};}
export function recordEvent(c,action,detail){return {...c,events:[...c.events,{at:new Date().toISOString(),action,detail}]};}
export function prepareRequest(c){return recordEvent({...c,draft:c.draft||correctionDraft(c.original,c.po,c.comparison)},'Correction request prepared','Draft only; no message sent.');}
export function receiveRevision(c,invoice){const comparison=compareDocuments(invoice,c.po);return recordEvent({...c,status:comparison.hasDiscrepancy?'revision_has_discrepancy':'revision_ready',revisions:[...c.revisions,{document:structuredClone(invoice),comparison,receivedAt:new Date().toISOString()}],paymentApproved:false},'Revised invoice received',`${invoice.number}; ${comparison.hasDiscrepancy?'discrepancy remains':'matches purchase order'}.`);}
export function resolveCase(c,confirmed,note){const latest=c.revisions.at(-1);if(!latest||latest.comparison.hasDiscrepancy)throw Error('A corrected invoice must match the purchase order before resolution.');if(c.status!=='revision_ready')throw Error('Case is not awaiting resolution.');if(!confirmed||!note?.trim())throw Error('Confirm the replacement invoice and record your verification note.');return recordEvent({...c,status:'resolved',paymentApproved:false},'Resolved by reviewer',note.trim());}
export function caseExport(c){return {...c,paymentStatus:c.status==='resolved'||c.status==='matched'?'NOT_APPROVED':'ON_HOLD',paymentApproved:false,exportedAt:new Date().toISOString()};}
// A reviewer correction of one extracted field (for example an OCR misread total). The same checks rerun on the
// corrected document, so an arithmetic warning updates or clears; payment stays unapproved either way.
export function correctExtraction(c,path,value,note){
 if(!note?.trim())throw Error('Record what you checked in the original document.');
 const latest=c.revisions.at(-1);
 const before=(latest?latest.comparison:c.comparison).arithmetic.filter(a=>a.document==='invoice').length;
 const document=correctField(latest?latest.document:c.original,path,value);
 const comparison=compareDocuments(document,c.po);
 const after=comparison.arithmetic.filter(a=>a.document==='invoice').length;
 const next=latest?{...c,revisions:[...c.revisions.slice(0,-1),{...latest,document,comparison}],status:comparison.hasDiscrepancy?'revision_has_discrepancy':'revision_ready'}
  :{...c,original:document,comparison,status:comparison.hasDiscrepancy?'open':'matched'};
 return recordEvent({...next,arithmeticReview:arithmeticReview(document),paymentApproved:false},'Extracted field corrected',
  `${path}: ${JSON.stringify(pathValue(latest?latest.document:c.original,path))} → ${JSON.stringify(value)}. Arithmetic warnings ${before} → ${after}. ${note.trim()}`);
}
