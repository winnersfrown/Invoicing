import {duplicateIssues} from './duplicates-engine.js';
export const money = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
export const cents = n => Math.round(Number(n)*100);
export function issuesFor(doc, all) {
 const issues=[]; const f=doc.fields;
 if (!f.vendor?.trim()) issues.push('Vendor is required.');
 if (!f.number?.trim()) issues.push('Invoice number is required.');
 if (!/^\d{4}-\d{2}-\d{2}$/.test(f.due||'') || !Number.isFinite(Date.parse(f.due))) issues.push('A valid due date is required.');
 if (![f.subtotal,f.tax,f.total].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)) issues.push('Amounts must be valid, nonnegative numbers.');
 else if (cents(f.subtotal)+cents(f.tax)!==cents(f.total)) issues.push(`Total mismatch: subtotal + tax should be ${money((cents(f.subtotal)+cents(f.tax))/100)}.`);
 issues.push(...duplicateIssues(doc,all));
 if(doc.lowConfidence&&!doc.verified) issues.push('Confirm the uncertain invoice details against the source.');
 return issues;
}
export function processDocs(docs) {return docs.map(d=>d.status==='queued'?{...d,status:issuesFor(d,docs).length?'review':'ready'}:d);}
export function approve(doc,all) {if(doc.status==='queued'||doc.status==='rejected'||issuesFor(doc,all).length) throw Error('Resolve invoice checks before approving.');return {...doc,status:'approved'};}
export function csv(docs) {const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';return ['Vendor,Invoice number,Due date,Subtotal,Tax,Total,Currency',...docs.filter(d=>d.status==='approved').map(d=>[d.fields.vendor,d.fields.number,d.fields.due,d.fields.subtotal,d.fields.tax,d.fields.total,'USD'].map(cell).join(','))].join('\r\n');}
export function parseInvoice(text) {
 const get=k=>text.match(new RegExp('^'+k+':\\s*(.*)$','mi'))?.[1]?.trim()||'';
 const number=k=>{const v=get(k).replace(/[$,]/g,'');return v!==''&&Number.isFinite(Number(v))?Number(v):null;};
 return {vendor:get('Vendor'),number:get('Invoice'),due:get('Due'),subtotal:number('Subtotal'),tax:number('Tax'),total:number('Total')};
}
