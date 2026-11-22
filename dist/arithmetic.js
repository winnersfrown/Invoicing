// Printed values stay separate from calculations. Reconcile using integer cents.
export const toCents = value => Math.round(Number(value) * 100);
const present = value => typeof value === 'number' && Number.isFinite(value);
export const adjustmentCents = (shipping, discount) =>
  (present(shipping) ? toCents(shipping) : 0) - (present(discount) ? toCents(discount) : 0);

export function percentageCents(baseCents, rate) {
  const scaled = Math.round(rate * 10000);
  if (!Number.isSafeInteger(baseCents) || !Number.isSafeInteger(scaled)) return null;
  const product = BigInt(baseCents)*BigInt(scaled);
  return Number(product < 0n ? -((-product+500000n)/1000000n) : (product+500000n)/1000000n);
}

// Inclusive invoices may show gross line prices or net lines with a gross total.
// Compare against the net subtotal, allowing the explicitly included tax.
export function netLineCents(sum, netSubtotal, tax, inclusive) {
  return inclusive && netSubtotal != null && tax != null && sum === netSubtotal + tax ? sum - tax : sum;
}

export function arithmeticChecks(d) {
  const checks = [];
  const add = (code,path,displayed,expected,label) => {
    if (!present(displayed) || !Number.isSafeInteger(expected)) return;
    const actual = toCents(displayed);
    if (actual !== expected) checks.push({code,path,displayedCents:actual,expectedCents:expected,
      differenceCents:actual-expected,
      message:`${label}: displayed ${(actual/100).toFixed(2)}; calculated ${(expected/100).toFixed(2)}${d.currency?' '+d.currency:''}.`,
      evidence:d.extraction?.fields?.[path]?.evidence||[]});
  };
  const lines = d.lines || [];
  const computed = lines.map((line,i) => {
    if (!present(line.quantity)) return null;
    const cents = present(line.ratePercent) ? percentageCents(toCents(line.quantity),line.ratePercent)
      : present(line.unitPrice) ? Math.round(line.quantity*toCents(line.unitPrice)) : null;
    add('line_amount',`lines.${i}.amount`,line.amount,cents,
      `Line ${i+1} ${present(line.ratePercent)?'basis × percentage':'quantity × unit price'}`);
    return cents;
  });
  const subtotal = present(d.subtotal) ? toCents(d.subtotal) : null;
  const tax = present(d.tax) ? toCents(d.tax) : null;
  const adjustment = adjustmentCents(d.shipping,d.discount);
  const net = sum => netLineCents(sum,subtotal,tax,d.taxInclusive);
  if (lines.length && computed.every(Number.isSafeInteger)) {
    const calculated=net(computed.reduce((sum,cents)=>sum+cents,0));
    add('subtotal','subtotal',d.subtotal,calculated,'Subtotal from line calculations');
    if(tax!=null)add('calculated_total','total',d.total,calculated+tax+adjustment,'Total from line calculations, tax and adjustments');
  }
  if (lines.length && lines.every(line=>present(line.amount))) {
    const printed=net(lines.reduce((sum,line)=>sum+toCents(line.amount),0));
    add('printed_line_sum','subtotal',d.subtotal,printed,'Subtotal from printed line amounts');
  }
  if (subtotal!=null && tax!=null) {
    add('displayed_total','total',d.total,subtotal+tax+adjustment,'Displayed subtotal + tax + shipping − discount');
  }
  if (present(d.taxRate) && subtotal!=null && !d.shipping && !d.discount) add('tax_rate','tax',d.tax,percentageCents(subtotal,d.taxRate),'Tax from displayed subtotal and tax rate');
  return checks;
}
