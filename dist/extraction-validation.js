// Intake may preserve missing fields. Matching and approval enforce completeness later.
export function validateExtractionReview(d){
 for(const k of ['subtotal','taxRate','tax','total'])if(d[k]!=null&&(!Number.isFinite(d[k])||d[k]<0))throw Error(`Enter a nonnegative ${k}, or leave it blank when unreadable.`);
 for(const [i,l] of d.lines.entries()){
  if(!Number.isInteger(l.quantity)||l.quantity<1)throw Error(`Line ${i+1}: enter a positive whole-number quantity.`);
  for(const k of ['unitPrice','amount'])if(l[k]!=null&&(!Number.isFinite(l[k])||l[k]<0))throw Error(`Line ${i+1}: invalid ${k}.`);
 }
 return d;
}
