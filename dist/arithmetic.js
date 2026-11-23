// Printed values stay separate from calculations. Reconcile using integer cents.
export const toCents = value => Math.round(Number(value) * 100);
const present = value => typeof value === 'number' && Number.isFinite(value);
const money = (cents, currency) => `${(cents / 100).toFixed(2)}${currency ? ' ' + currency : ''}`;

export const FEE_KINDS = ['shipping', 'freight', 'fuel_surcharge', 'handling', 'other_fee'];
export const ADJUSTMENT_KINDS = [...FEE_KINDS, 'discount', 'credit_applied', 'payment'];

// Records saved before adjustment lists carry one shipping and one discount value.
export function adjustmentsOf(d) {
  if (Array.isArray(d?.adjustments)) return d.adjustments;
  const legacy = (kind, description, cents) => ({kind, description, cents, taxable: 'unknown', appliesTo: 'total', sourceText: '', evidence: []});
  return [
    present(d?.shipping) && d.shipping !== 0 && legacy('shipping', 'Shipping / freight', toCents(d.shipping)),
    present(d?.discount) && d.discount !== 0 && legacy('discount', 'Discount', -Math.abs(toCents(d.discount)))
  ].filter(Boolean);
}

// Printed tax rows. A tax total edited after extraction replaces the rows it no longer matches.
export function taxesOf(d) {
  let taxes = Array.isArray(d?.taxes) ? d.taxes : [];
  const edited = present(d?.tax) && (!taxes.length || taxes.some(t => !Number.isSafeInteger(t.cents)) ||
    taxes.reduce((s, t) => s + t.cents, 0) !== toCents(d.tax));
  if (edited) {
    const only = taxes.length === 1 ? taxes[0] : {};
    taxes = [{label: only.label || 'Tax', ratePercent: only.ratePercent ?? null, basisCents: only.basisCents ?? null, cents: toCents(d.tax), sourceText: '', evidence: [], path: 'tax'}];
  }
  if (taxes.length === 1 && taxes[0].ratePercent == null && present(d?.taxRate)) taxes = [{...taxes[0], ratePercent: d.taxRate}];
  return taxes;
}

/** Signed cents of the adjustments before the invoice total ('total') or between total and balance due ('balance'); null if one is unreadable. */
export function adjustmentCents(d, appliesTo = 'total') {
  const list = adjustmentsOf(d).filter(a => (a.appliesTo || 'total') === appliesTo);
  return list.every(a => Number.isSafeInteger(a.cents)) ? list.reduce((s, a) => s + a.cents, 0) : null;
}

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

// A value that reconciles after changing one digit, or after moving the decimal point two places, is a typical OCR misread.
export function oneDigitApart(read, target) {
  if (!Number.isSafeInteger(read) || !Number.isSafeInteger(target) || read === target || read * target < 0) return false;
  const [a, b] = [String(Math.abs(read)), String(Math.abs(target))];
  if (a.length === b.length && [...a].filter((c, i) => c !== b[i]).length === 1) return true;
  return target !== 0 && (read === target * 100 || read * 100 === target);
}

/** Convert cents with a printed rate {base, quote, rate, decimals}: {cents, toleranceCents}, or null when the rate does not link the currencies. */
export function convertCents(cents, from, to, fx) {
  const micros = Math.round(fx.rate * 1e6);
  if (!Number.isSafeInteger(cents) || !(micros > 0)) return null;
  const forward = !fx.base || (from === fx.base && to === fx.quote);
  if (!forward && !(from === fx.quote && to === fx.base)) return null;
  const n = BigInt(cents), m = BigInt(micros);
  const value = forward ? (n * m + 500000n) / 1000000n : (n * 1000000n + m / 2n) / m;
  // A printed rate is rounded to its decimals: allow that error on this amount, plus one cent of final rounding.
  const rateError = 0.5 * 10 ** -(fx.decimals ?? 6);
  const toleranceCents = Math.ceil(Math.abs(cents) * rateError / (forward ? 1 : fx.rate ** 2)) + 1;
  return {cents: Number(value), toleranceCents};
}

/**
 * All arithmetic checks, split into confirmed contradictions (inputs read with good support and they disagree),
 * uncertain results (an input is missing, unreadable, low-confidence OCR or a likely OCR misread) and passes.
 * Arithmetic runs in the pricing currency only; conversions are reported separately with a stated tolerance.
 */
export function arithmeticReview(d) {
  const out = {contradictions: [], uncertain: [], passed: [], conversions: []};
  const fields = d.extraction?.fields || {};
  const currency = d.pricingCurrency || d.currency || '';
  const settled = path => d.extractionReviewed || fields[path]?.confirmed;
  const ocr = path => !settled(path) && Boolean(fields[path]?.evidence?.some(e => e.method === 'ocr'));
  // Quantities that reconcile only with a restored decimal point; later checks built on them stay uncertain too.
  const quantitySuspects = new Set();
  const doubt = path => {
    if (quantitySuspects.has(path)) return 'OCR may have dropped a decimal point in this quantity';
    const f = fields[path];
    if (!f || settled(path)) return '';
    if (f.needsConfirmation) return f.reason || 'Needs reviewer confirmation.';
    return f.support === 'uncertain' && ocr(path) ? 'low-confidence OCR read' : '';
  };

  // inputs: numeric operands (may be OCR misreads); refs: other source fields, for evidence and doubt only.
  function check({code, path, label, displayed, expected, inputs = [], refs = [], tolerance = 0, list = null, cur = currency, note, quantity = null}) {
    const paths = [path, ...inputs.map(i => i.path), ...refs];
    const numbers = {displayed: displayed == null ? null : money(displayed, cur), calculated: expected == null ? null : money(expected, cur),
      inputs: Object.fromEntries(inputs.map(i => [i.path, i.cents == null ? 'unknown' : money(i.cents, cur)]))};
    const base = {code, path, label, currency: cur, displayedCents: displayed, expectedCents: expected, numbers,
      evidence: paths.flatMap(p => fields[p]?.evidence || []), ...(note ? {note} : {})};
    if (displayed == null || expected == null) {
      const unknown = displayed == null ? [path] : inputs.filter(i => i.cents == null).map(i => i.path);
      (list || out.uncertain).push({...base, status: 'uncertain', differenceCents: null,
        message: `${label}: cannot check because ${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} missing or unreadable. Unknown values are not treated as zero.`});
      return;
    }
    const differenceCents = displayed - expected;
    if (Math.abs(differenceCents) <= tolerance) return void (list || out.passed).push({...base, status: 'pass', differenceCents});
    const suspects = [];
    if (ocr(path) && oneDigitApart(displayed, expected)) suspects.push({path, readCents: displayed, candidateCents: expected});
    for (const i of inputs) if (ocr(i.path) && oneDigitApart(i.cents, i.cents + differenceCents))
      suspects.push({path: i.path, readCents: i.cents, candidateCents: i.cents + differenceCents});
    // OCR also drops the decimal point in a quantity ("2.5" read as "25").
    if (quantity && ocr(quantity.path)) for (const scale of [10, 100]) {
      const candidate = quantity.value / scale;
      if (Math.round(candidate * quantity.priceCents) === displayed) { suspects.push({path: quantity.path, quantity: {read: quantity.value, candidate}}); quantitySuspects.add(quantity.path); break; }
    }
    const doubts = [...new Set(paths)].map(p => doubt(p) && `${p}: ${doubt(p)}`).filter(Boolean);
    const plain = `${label}: displayed ${money(displayed, cur)}; calculated ${money(expected, cur)}`;
    if (suspects.length || doubts.length) {
      (list || out.uncertain).push({...base, status: 'uncertain', differenceCents, suspects, message:
        `${plain} (difference ${money(differenceCents, cur)}). Not classed as an error yet: ${[...suspects.map(s => s.quantity ? `${s.path} may be an OCR misread (quantity ${s.quantity.read} would reconcile as ${s.quantity.candidate})` : `${s.path} may be an OCR misread (${money(s.readCents, cur)} would reconcile as ${money(s.candidateCents, cur)})`), ...doubts].join('; ')}. Confirm against the original.`});
    } else (list || out.contradictions).push({...base, status: 'contradiction', differenceCents, message: `${plain}.`});
  }

  // Line arithmetic.
  const lines = d.lines || [];
  const computed = lines.map((line, i) => {
    if (!present(line.quantity)) return null;
    const rate = present(line.ratePercent);
    const cents = rate ? percentageCents(toCents(line.quantity), line.ratePercent)
      : present(line.unitPrice) ? Math.round(line.quantity * toCents(line.unitPrice)) : null;
    if (present(line.amount) && cents != null) check({code: 'line_amount', path: `lines.${i}.amount`, displayed: toCents(line.amount), expected: cents,
      label: `Line ${i + 1} ${rate ? 'basis × percentage' : 'quantity × unit price'}`, refs: [`lines.${i}.quantity`, `lines.${i}.${rate ? 'ratePercent' : 'unitPrice'}`],
      quantity: rate ? null : {path: `lines.${i}.quantity`, value: line.quantity, priceCents: toCents(line.unitPrice)}});
    return cents;
  });

  const subtotal = present(d.subtotal) ? toCents(d.subtotal) : null;
  const taxes = taxesOf(d);
  const taxInputs = taxes.map((t, i) => ({path: t.path || `taxes.${i}`, cents: Number.isSafeInteger(t.cents) ? t.cents : null}));
  const sumOf = inputs => inputs.every(i => i.cents != null) ? inputs.reduce((s, i) => s + i.cents, 0) : null;
  const tax = taxes.length ? sumOf(taxInputs) : null;
  const adjustments = adjustmentsOf(d);
  const adjInput = a => ({path: a.path || `adjustments.${adjustments.indexOf(a)}`, cents: Number.isSafeInteger(a.cents) ? a.cents : null});
  const preTotal = adjustments.filter(a => (a.appliesTo || 'total') === 'total');
  const net = sum => netLineCents(sum, subtotal, tax, d.taxInclusive);
  const lineRefs = lines.map((_, i) => `lines.${i}.amount`);
  // Checks built from quantity × price also rest on each quantity.
  const calculationRefs = [...lineRefs, ...lines.map((_, i) => `lines.${i}.quantity`)];

  if (lines.length && computed.every(Number.isSafeInteger) && subtotal != null) check({code: 'subtotal', path: 'subtotal',
    label: 'Subtotal from line calculations', displayed: subtotal, expected: net(computed.reduce((s, c) => s + c, 0)), refs: calculationRefs});
  if (lines.length && lines.every(line => present(line.amount)) && subtotal != null) {
    const amounts = lines.map((line, i) => ({path: `lines.${i}.amount`, cents: toCents(line.amount)}));
    check({code: 'printed_line_sum', path: 'subtotal', label: 'Subtotal from printed line amounts', displayed: subtotal, expected: net(sumOf(amounts)), inputs: amounts});
  }

  // Invoice total in the pricing currency.
  const dual = Boolean(d.pricingCurrency && d.currency && d.pricingCurrency !== d.currency);
  const totalPath = dual ? 'pricingTotal' : 'total';
  const printedTotal = dual ? d.pricingTotal : d.total;
  const billed = present(printedTotal) ? toCents(printedTotal) : null;
  const base = subtotal != null ? {path: 'subtotal', cents: subtotal}
    : lines.length && computed.every(Number.isSafeInteger) ? {path: 'lines', cents: net(computed.reduce((s, c) => s + c, 0))} : null;
  const totalInputs = base ? [base, ...preTotal.map(adjInput), ...taxInputs] : [];
  if (billed != null && base) {
    if (!taxes.length) {
      // No tax row printed: a total equal to subtotal + adjustments is consistent; any other gap may be unprinted tax.
      const withoutTax = sumOf([base, ...preTotal.map(adjInput)]);
      if (withoutTax === billed) check({code: 'displayed_total', path: totalPath, label: 'Displayed subtotal + adjustments', displayed: billed, expected: withoutTax,
        inputs: totalInputs, note: 'Consistent with no tax charged; the tax amount stays unknown, not zero.'});
      else check({code: 'displayed_total', path: totalPath, label: 'Total with no printed tax amount', displayed: billed, expected: null, inputs: [...totalInputs, {path: 'tax', cents: null}]});
    } else if (base.path === 'lines') check({code: 'calculated_total', path: totalPath, label: 'Total from line calculations, tax and adjustments', displayed: billed, expected: sumOf(totalInputs), inputs: totalInputs});
    else check({code: 'displayed_total', path: totalPath, label: 'Displayed subtotal + taxes + adjustments', displayed: billed, expected: sumOf(totalInputs), inputs: totalInputs});
  }
  if (lines.length && computed.every(Number.isSafeInteger) && subtotal != null && tax != null && billed != null) {
    const expected = net(computed.reduce((s, c) => s + c, 0)) + tax + (adjustmentCents(d) ?? NaN);
    if (Number.isSafeInteger(expected) && expected !== billed && sumOf(totalInputs) === billed)
      check({code: 'calculated_total', path: totalPath, label: 'Total from line calculations, tax and adjustments', displayed: billed, expected, refs: calculationRefs});
  }

  // Balance due after credits, deposits or payments printed below the total.
  const after = adjustments.filter(a => a.appliesTo === 'balance');
  if (present(d.amountDue) && after.length) {
    const inputs = [{path: totalPath, cents: billed ?? (totalInputs.length && tax != null ? sumOf(totalInputs) : null)}, ...after.map(adjInput)];
    check({code: 'amount_due', path: 'amountDue', label: 'Invoice total − payments and credits applied', displayed: toCents(d.amountDue), expected: sumOf(inputs), inputs});
  }

  // Listed taxes against a printed tax total.
  if (present(d.taxTotal) && taxes.length > 1) check({code: 'tax_sum', path: 'taxTotal', label: 'Sum of listed taxes', displayed: toCents(d.taxTotal), expected: tax, inputs: taxInputs});

  // Tax from rate and basis: the printed basis, the printed taxable amount, or the subtotal with each adjustment of unknown taxability in or out.
  const tolerance = lines.length > 1 ? Math.ceil(lines.length / 2) : 0; // per-line tax rounding: up to half a cent per line
  taxes.forEach((t, i) => {
    if (!present(t.ratePercent) || !Number.isSafeInteger(t.cents) || t.included) return;
    const path = taxInputs[i].path, name = `${t.label || 'Tax'} at ${t.ratePercent}%`;
    const expectedOn = basis => percentageCents(basis, t.ratePercent);
    if (Number.isSafeInteger(t.basisCents) || present(d.taxableAmount)) {
      const basis = Number.isSafeInteger(t.basisCents) ? t.basisCents : toCents(d.taxableAmount);
      return check({code: 'tax_rate', path, label: `${name} of ${money(basis, currency)}`, displayed: t.cents, expected: expectedOn(basis), refs: [present(d.taxableAmount) ? 'taxableAmount' : path], tolerance});
    }
    if (subtotal == null) return;
    const optional = preTotal.filter(a => a.taxable !== true && a.taxable !== false && Number.isSafeInteger(a.cents)).slice(0, 6);
    const fixed = preTotal.filter(a => a.taxable === true && Number.isSafeInteger(a.cents)).reduce((s, a) => s + a.cents, 0);
    const bases = [];
    for (let mask = 0; mask < 2 ** optional.length; mask++) bases.push(subtotal + fixed + optional.reduce((s, a, k) => s + (mask >> k & 1 ? a.cents : 0), 0));
    const tries = [];
    for (const basis of bases) {
      check({code: 'tax_rate', path, label: `${name} of ${money(basis, currency)}`, displayed: t.cents, expected: expectedOn(basis), refs: ['subtotal'], tolerance, list: tries});
      if (tries.at(-1).status === 'pass') return void out.passed.push({...tries.at(-1), basisCents: basis});
    }
    const failed = {...tries[0], label: name};
    const sameTaxNoBasis = taxes.filter(x => x.basisCents == null && present(x.ratePercent) && x.ratePercent !== t.ratePercent &&
      (x.label || '').split(/\W/)[0].toLowerCase() === (t.label || '').split(/\W/)[0].toLowerCase());
    if (sameTaxNoBasis.length) out.uncertain.push({...failed, status: 'uncertain',
      message: `${name}: the taxable amount for each rate is not printed, so this rate cannot be checked against the subtotal.`});
    else if (failed.status === 'uncertain') out.uncertain.push(failed);
    else out.contradictions.push({...failed, message: `Tax from displayed subtotal and tax rate: ${name} displayed ${money(t.cents, currency)}; calculated ${money(failed.expectedCents, currency)} on ${money(subtotal, currency)}${optional.length ? ', with or without each adjustment of unknown taxability' : ''}.`});
  });

  // Conversions between currencies are separate checks with a stated rounding tolerance.
  const fx = d.exchangeRate;
  const convert = (code, fromCents, from, to, path, displayed, labelText) => {
    if (!fx || !from || !to || from === to || !present(displayed) || fromCents == null) return;
    const c = convertCents(fromCents, from, to, fx);
    if (!c) return;
    // Pass: equal at the printed rate (±1 cent). Uncertain: within what the rate's rounding could explain. Contradiction: beyond it.
    const rate = fx.base ? `1 ${fx.base} = ${fx.rate} ${fx.quote}` : `rate ${fx.rate}`;
    const result = [];
    check({code, path, displayed: toCents(displayed), expected: c.cents, refs: [totalPath, 'exchangeRate'], tolerance: 1, list: result, cur: to,
      label: `${labelText}: ${money(fromCents, from)} at ${rate} (rounding tolerance ±${money(c.toleranceCents, to)} for a rate printed to ${fx.decimals} decimals)`});
    const [r] = result;
    out.conversions.push(r.status === 'contradiction' && Math.abs(r.differenceCents) <= c.toleranceCents
      ? {...r, status: 'uncertain', message: `${r.message} The difference is within what rounding of the printed rate could cause, so it is not classed as an error; confirm the conversion with the supplier if it matters.`} : r);
  };
  const pricedTotal = billed ?? (base && tax != null ? sumOf(totalInputs) : null);
  if (dual) convert('conversion', pricedTotal, d.pricingCurrency, d.currency, 'total', d.total, `Payable total converted from ${d.pricingCurrency}`);
  if (d.referenceTotal) convert('reference_conversion', present(d.total) ? toCents(d.total) : null, d.currency, d.referenceTotal.currency, 'referenceTotal', d.referenceTotal.value, 'Reference-only total');
  return out;
}

/** Confirmed contradictions only, plus failed currency conversions. Uncertain results are in arithmeticReview(d).uncertain. */
export function arithmeticChecks(d) {
  const r = arithmeticReview(d);
  return [...r.contradictions, ...r.conversions.filter(c => c.status === 'contradiction')];
}

export const pathValue = (d, path) => {
  const [head, index, key] = path.split('.');
  if (head === 'taxes' || head === 'adjustments') { const cents = d[head]?.[index]?.cents; return Number.isSafeInteger(cents) ? cents / 100 : null; }
  if (head === 'lines') return d.lines?.[index]?.[key] ?? null;
  if (head === 'exchangeRate') return d.exchangeRate?.rate ?? null;
  return d[head] ?? null;
};


/** Fields that must be explicitly confirmed or corrected by the reviewer: [{path, value, reason, candidates, evidence}]. */
export function pendingConfirmations(d) {
  return Object.entries(d.extraction?.fields || {}).filter(([, f]) => f.needsConfirmation && !f.confirmed)
    .map(([path, f]) => ({path, label: f.label || '', value: pathValue(d, path), reason: f.reason || '', candidates: f.candidates || [], evidence: f.evidence || []}));
}

/** A reviewer confirmation or correction of one extracted field. Returns a new document with every check rerun. */
export function correctField(doc, path, value) {
  const d = structuredClone(doc);
  const [head, index, key] = path.split('.');
  const cents = value == null || value === '' ? null : toCents(value);
  if (head === 'taxes' || head === 'adjustments') {
    d[head][index].cents = cents;
    if (head === 'taxes') d.tax = d.taxes.every(t => Number.isSafeInteger(t.cents)) ? d.taxes.reduce((s, t) => s + t.cents, 0) / 100 : null;
    else {
      const sum = kinds => { const list = d.adjustments.filter(a => kinds.includes(a.kind) && Number.isSafeInteger(a.cents)); return list.length ? list.reduce((s, a) => s + a.cents, 0) / 100 : null; };
      d.shipping = sum(FEE_KINDS);
      const off = d.adjustments.filter(a => ['discount', 'credit_applied'].includes(a.kind) && (a.appliesTo || 'total') === 'total' && Number.isSafeInteger(a.cents));
      d.discount = off.length ? -off.reduce((s, a) => s + a.cents, 0) / 100 : null;
    }
  } else if (head === 'lines') d.lines[index][key] = value;
  else if (head === 'exchangeRate') d.exchangeRate = {...d.exchangeRate, rate: Number(value), decimals: String(value).split('.')[1]?.length ?? 0};
  else d[head] = value;
  d.extraction ??= {fields: {}};
  d.extraction.fields ??= {};
  d.extraction.fields[path] = {...d.extraction.fields[path], value, confirmed: true, needsConfirmation: false, reviewedValue: value};
  d.arithmeticReview = arithmeticReview(d);
  // An OCR-misread suspicion only existed because a check failed; once that check reconciles, the suspicion clears.
  const stillSuspect = new Set(d.arithmeticReview.uncertain.flatMap(c => (c.suspects || []).map(s => s.path)));
  for (const f of Object.entries(d.extraction.fields).filter(([p, f]) => f.suspectedBy && f.needsConfirmation && !stillSuspect.has(p)).map(([, f]) => f))
    Object.assign(f, {needsConfirmation: false, support: 'supported', reason: 'Reconciles after the reviewer correction of another field.'});
  d.arithmetic = arithmeticChecks(d);
  return d;
}
