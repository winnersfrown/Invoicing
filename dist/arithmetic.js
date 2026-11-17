// USD arithmetic uses integer cents. Printed values stay separate from calculations.
export const toCents = value => Math.round(Number(value) * 100);
const present = v => typeof v === 'number' && Number.isFinite(v);
export function arithmeticChecks(d) {
 const checks=[];
 const add=(code,path,displayed,expected,label)=>{if(!present(displayed)||!Number.isSafeInteger(expected))return;const actual=toCents(displayed);if(actual!==expected)checks.push({code,path,displayedCents:actual,expectedCents:expected,differenceCents:actual-expected,message:`${label}: displayed $${(actual/100).toFixed(2)}; calculated $${(expected/100).toFixed(2)}.`,evidence:d.extraction?.fields?.[path]?.evidence||[]});};
 const lines=d.lines||[];
 const calculable=lines.length&&lines.every(l=>present(l.quantity)&&present(l.unitPrice));
 for(const [i,l] of lines.entries())if(present(l.quantity)&&present(l.unitPrice))add('line_amount',`lines.${i}.amount`,l.amount,l.quantity*toCents(l.unitPrice),`Line ${i+1} quantity × unit price`);
 if(calculable){const calculated=lines.reduce((sum,l)=>sum+l.quantity*toCents(l.unitPrice),0);add('subtotal','subtotal',d.subtotal,calculated,'Subtotal from quantities and prices');if(present(d.tax))add('calculated_total','total',d.total,calculated+toCents(d.tax),'Total from quantities, prices and tax');}
 if(lines.length&&lines.every(l=>present(l.amount)))add('printed_line_sum','subtotal',d.subtotal,lines.reduce((sum,l)=>sum+toCents(l.amount),0),'Subtotal from printed line amounts');
 if(present(d.subtotal)&&present(d.tax))add('displayed_total','total',d.total,toCents(d.subtotal)+toCents(d.tax),'Displayed subtotal + tax');
 // Only an explicitly extracted document-wide rate is checked here. Multiple rates need review.
 if(present(d.taxRate)&&present(d.subtotal)&&Number.isSafeInteger(toCents(d.subtotal))&&Number.isSafeInteger(Math.round(d.taxRate*100)))add('tax_rate','tax',d.tax,Number((BigInt(toCents(d.subtotal))*BigInt(Math.round(d.taxRate*100))+5000n)/10000n),'Tax from displayed subtotal and tax rate');
 return checks;
}
