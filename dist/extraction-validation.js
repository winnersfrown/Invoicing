import {arithmeticReview} from './arithmetic.js';

export function lineReviewReasons(d, checks=arithmeticReview(d), structured=false){
 const lines=d.lines||[];
 const reasons=[];
 if(!lines.length)reasons.push('No line items were read. Compare every printed row with the source.');
 for(const [i,line] of lines.entries()){
  const missing=[];
  if(!line.description?.trim())missing.push('description');
  if(!Number.isFinite(line.quantity))missing.push('quantity or basis');
  if(!Number.isFinite(line.unitPrice)&&!Number.isFinite(line.ratePercent))missing.push('price or rate');
  // Structured JSON permits an omitted extended amount. A null or unread
  // amount from a printed document still needs an explicit source check.
  if(line.amount==null && !(structured && !Object.hasOwn(line,'amount')))missing.push('printed amount');
  if(missing.length)reasons.push(`Line ${i+1} needs review for ${missing.join(', ')}.`);
 }
 if([...checks.contradictions,...checks.uncertain].some(c=>['subtotal','printed_line_sum'].includes(c.code)&&c.differenceCents))
  reasons.push('The line sum differs from the subtotal. Check for missing or repeated items.');
 for(const row of d.extraction?.unassignedRows||[])reasons.push(`Unassigned table text on page ${row.page}: ${row.text}`);
 return reasons;
}

// Intake may preserve missing fields. Matching and approval enforce completeness later.
export function validateExtractionReview(d){
 for(const k of ['subtotal','taxRate','tax','total','shipping','discount'])if(d[k]!=null&&(!Number.isFinite(d[k])||d[k]<0))throw Error(`Enter a nonnegative ${k}, or leave it blank when unreadable.`);
 for(const [i,l] of d.lines.entries()){
  if(!l.description?.trim())throw Error(`Line ${i+1}: enter the description from the source or remove the spurious row.`);
  if(l.unitPrice==null&&l.ratePercent==null)throw Error(`Line ${i+1}: verify the unit price or percentage rate before continuing.`);
  if(!Number.isFinite(l.quantity)||l.quantity<=0||Math.abs(l.quantity*1000-Math.round(l.quantity*1000))>1e-7)throw Error(`Line ${i+1}: enter a positive quantity or basis with up to three decimal places.`);
  for(const k of ['unitPrice','amount','ratePercent'])if(l[k]!=null&&(!Number.isFinite(l[k])||l[k]<0))throw Error(`Line ${i+1}: invalid ${k}.`);
 }
 return d;
}
