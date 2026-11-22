// Intake may preserve missing fields. Matching and approval enforce completeness later.
export function validateExtractionReview(d){
 for(const k of ['subtotal','taxRate','tax','total','shipping','discount'])if(d[k]!=null&&(!Number.isFinite(d[k])||d[k]<0))throw Error(`Enter a nonnegative ${k}, or leave it blank when unreadable.`);
 for(const [i,l] of d.lines.entries()){
  if(!Number.isFinite(l.quantity)||l.quantity<=0||Math.abs(l.quantity*1000-Math.round(l.quantity*1000))>1e-7)throw Error(`Line ${i+1}: enter a positive quantity or basis with up to three decimal places.`);
  for(const k of ['unitPrice','amount','ratePercent'])if(l[k]!=null&&(!Number.isFinite(l[k])||l[k]<0))throw Error(`Line ${i+1}: invalid ${k}.`);
 }
 return d;
}
