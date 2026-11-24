const symbols = {'US$':'USD','USD$':'USD','CA$':'CAD','C$':'CAD','AU$':'AUD','A$':'AUD','NZ$':'NZD','HK$':'HKD','S$':'SGD','N$':'NAD','€':'EUR','₹':'INR'};
// Symbols several currencies share. They stay unconfirmed until another signal or the reviewer settles them.
export const sharedSymbols = {'$':['USD','CAD','AUD','NZD','SGD','HKD','MXN'],'R':['ZAR'],'K':['ZMW'],'KR':['SEK','NOK','DKK','ISK'],'¥':['JPY','CNY'],'£':['GBP','EGP','GIP'],'₤':[]};
const codes = new Set(typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('currency') : ['USD','CAD','AUD','NZD','SGD','HKD','EUR','GBP','JPY','CHF','INR','CNY','MXN','NAD','ZAR','ZMW']);
export const isCurrency = code => codes.has(code);

export function readMoney(input, maxDecimals = 2) {
  const source = String(input ?? '').trim();
  const match = source.match(/^([+-])?\s*([A-Za-z]{1,3}\s*\$|[A-Za-z]{1,3}|[$€£₹¥₤])?\s*([+-]?[0-9](?:[0-9., '  ’]*[0-9])?)\s*([A-Za-z]{3}|[$€£₹¥₤])?$/u);
  if (!match || (match[2] && match[4]) || (match[1] && /^[+-]/.test(match[3]))) return null;
  const marker = (match[2] || match[4] || '').replace(/\s+/g,'').toUpperCase();
  const currency = symbols[marker] || (isCurrency(marker) ? marker : '');
  if (marker && !currency && !sharedSymbols[marker]) return null;

  const sign = (match[1] || match[3]).startsWith('-') ? -1 : 1;
  const number = match[3].replace(/^[+-]/,'').replace(/[  ]/g,' ').replace(/’/g,"'");
  const separatorIndex = Math.max(number.lastIndexOf('.'), number.lastIndexOf(','));
  const digitsAfter = number.length - separatorIndex - 1;
  const decimal = separatorIndex >= 0 && digitsAfter <= maxDecimals
    && (digitsAfter !== 3 || maxDecimals > 2);
  const integer = number.slice(0, decimal ? separatorIndex : undefined);
  const fraction = decimal ? number.slice(separatorIndex+1) : '';
  if ((fraction && !/^\d+$/.test(fraction)) ||
      !/^\d+$|^\d{1,3}([., '])\d{3}(?:\1\d{3})*$/.test(integer) ||
      (decimal && integer.includes(number[separatorIndex]))) return null;
  const value = sign * Number(integer.replace(/[., ']/g,'') + (fraction ? '.'+fraction : ''));
  return Number.isFinite(value) ? {value,currency,marker} : null;
}

// Charges and reductions between the subtotal and the total (payments sit between the total and the balance due).
const adjustmentLabels = [
  ['fuel_surcharge', /^fuel\s+(?:sur)?charge\b/i],
  ['freight', /^(?:(?:accessorial|additional|inbound|outbound)\s+)?(?:freight|accessorial(?:\s+charges?)?|lift[- ]?gate|residential\s+delivery|delivery)(?:\s+(?:charges?|fees?))?\b/i],
  ['shipping', /^(?:shipping(?:\s+(?:and|&)\s+handling)?|s\s*&\s*h|postage|carriage)(?:\s+(?:charges?|fees?))?\b/i],
  ['handling', /^handling(?:\s+(?:charges?|fees?))?\b/i],
  ['other_fee', /^(?:service(?=\s+(?:charge|fee))|(?:restocking|set-?up|admin(?:istration)?|processing|environmental|small\s+order|rush|packaging|insurance)(?=\s+(?:charge|fee))|surcharge)(?:\s+(?:charges?|fees?))?\b/i],
  ['discount', /^(?:(?:(?:less|total|loyalty|trade|early\s+payment|volume)\s+)?discount\b|promo[- ]+[\w-]+)/i],
  ['credit_applied', /^(?:(?:less\s+)?credits?(?:\s+(?:memo|note))?(?:\s+#?\s*[A-Z]{0,4}-?\d[\w-]*)?(?:\s+applied)?|applied\s+credit)\b/i],
  ['payment', /^(?:less\s+)?(?:deposit|payments?|amount\s+paid|prepayment|advance(?:\s+payment)?|paid)(?:\s+(?:received|paid|applied|made))?(?:\s+(?:on\s+)?\d{4}-\d{2}-\d{2})?(?=\s|$|:)/i]
];
const reductions = new Set(['discount','credit_applied','payment']);
const taxLabel = /^(?:(?:(?:[A-Z]{2}|state|county|city|local|provincial|federal|municipal)\s+)?sales\s+(?:and\s+use\s+)?tax|(?:state|county|city|local|provincial|federal|municipal)\s+tax|(?:vat|tva|mwst|ust|iva|btw|gst|hst|pst|qst|rst|igst|cgst|sgst)(?:\s+amount)?|tax(?:\s+amount)?)\b/i;

const prefixes = [
  ['subtotalExclusive', /^(?:total\s+exclusive(?:\s+of\s+(?:vat|tax))?|net\s+(?:amount|total)|sub\s*total\s*(?:\(?(?:excl(?:usive)?\.?)(?:\s+(?:vat|tax))?\)?))\b/i],
  ['taxableAmount', /^taxable\s+(?:amount|sub\s*total|total|sales|value|base)\b/i],
  ['subtotal', /^sub\s*total\b/i],
  ['taxTotal', /^total\s+(?:vat|tax(?:es)?|gst|sales\s+tax)\b/i],
  ['tax', taxLabel],
  ['referenceTotal', /^(?:(?:total|amount)\s+)?(?:equivalent|reference|indicative|approx(?:imate)?\.?)(?:\s+(?:total|amount|value))?\b/i],
  ['amountDue', /^(?:total\s+(?:due|payable)|amount\s+(?:due|payable|to\s+pay)|balance(?:\s+(?:due|payable|outstanding|remaining))?|net\s+(?:amount\s+)?(?:due|payable)|please\s+pay)\b/i],
  ['total', /^(?:(?:grand|invoice)\s+total|total(?:\s+(?:amount|invoice|charges))?)(?:\s+incl(?:\.|uding|usive(?:\s+of)?)?\s+(?:vat|tax|gst|mwst))?\b/i],
  ...adjustmentLabels.map(([kind, pattern]) => ['adjustment', pattern, kind])
];

// Descriptors that may sit between a label and its amount; each is consumed in any order.
const descriptors = [
  ['rate', /^\(?\s*(?:@|at)?\s*(\d+(?:[.,]\d+)?)\s*%\s*\)?/],
  ['included', /^(?:\((?:vat\s+|tax\s+)?incl(?:uded|usive)?\.?\)|included(?:\s+in\s+(?:the\s+)?(?:total|price))?|incl(?:uded|usive)?\.?)/i],
  ['partial', /^on\s+(?:fees|services|labou?r)\b/i],
  ['treatment', /^\(?\s*(zero[- ]rated|(?:tax[- ])?exempt|reverse[- ]charge)\s*\)?/i],
  ['reference', /^\((?:for\s+)?(?:reference|information|indicative)(?:\s+(?:only|purposes))?\)/i],
  ['taxable', /^\(\s*((?:non[- ]?|not\s+)?taxable|tax\s+exempt|no\s+tax)\s*\)/i],
  ['code', /^(?:\(([A-Z]{3})\)|in\s+([A-Z]{3})\b)/],
  ['note', /^\([^)]*\)/],
  ['applied', /^applied\b/i],
  ['colon', /^[:=]/]
];

function readDescriptors(rest, key) {
  const found = {};
  for (let progress = true; progress && rest;) {
    progress = false;
    for (const [name, pattern] of descriptors) {
      if (name === 'note' && key !== 'adjustment') continue;
      const m = pattern.exec(rest);
      if (!m) continue;
      found[name] = m[1] || m[2] || m[0];
      rest = rest.slice(m[0].length).trim();
      progress = true;
    }
  }
  return {rest, found};
}

const looksNumeric = s => /^[^A-Za-z]*\d[^A-Za-z]*(?:\s*[A-Za-z]{3})?$/.test(s);

/** One summary row: {key, kind?, value (signed for adjustments), currency, marker, rate, basis, treatment, taxable, included, reference, unreadable}. */
export function readSummary(row, inTable) {
  for (const [key, pattern, kind] of prefixes) {
    const label = row.match(pattern);
    if (!label) continue;
    // A freight/discount table row may contain quantity, rate and amount.
    if (inTable && key === 'adjustment' && row.trim().split(/\s*\|\s*| {2,}|\t/).length > 2) return null;
    let source = row.slice(label[0].length).trim();
    const trailing = /\s*\((?:for\s+)?(?:reference|information)(?:\s+(?:only|purposes))?\)\s*$/i.exec(source);
    if (trailing) source = source.slice(0, trailing.index);
    const {rest, found} = readDescriptors(source, key);
    let amount = readMoney(rest), basis = null;
    if (!amount && key === 'tax') {
      // "VAT 20% on 1,000.00 200.00": a printed basis before the tax amount.
      const words = rest.replace(/^(?:on|of)\s+/i, '').split(/\s+/);
      for (let k = 1; k < words.length && !amount; k++) {
        const b = readMoney(words.slice(0, k).join(' ').replace(/:$/, '')), a = readMoney(words.slice(k).join(' '));
        if (b && a) [basis, amount] = [b.value, a];
      }
    }
    const treatment = found.treatment ? found.treatment.toLowerCase().replace(/^tax[- ]/, '').replace(/[- ]/, '_') : '';
    if (!amount && key === 'tax' && treatment && (!rest || /^[-–—]$/.test(rest))) amount = {value: 0, currency: '', marker: ''};
    const code = found.code && isCurrency(found.code) ? found.code : '';
    const taxable = found.taxable ? !/non|not|exempt|no\s/i.test(found.taxable) : 'unknown';
    const common = {key, ...(kind ? {kind} : {}), label: label[0], rate: found.rate && !found.partial ? Number(found.rate.replace(',', '.')) : null,
      basis, treatment, included: Boolean(found.included), reference: Boolean(found.reference || trailing), taxable};
    if (!amount) {
      if (key === 'tax' && found.rate && !rest) return {...common, rateOnly:true, value:null, currency:code, marker:''};
      // A labelled amount that cannot be read stays unknown and is flagged; it is never zero.
      if (rest && (looksNumeric(rest) || (key==='tax' && found.rate && !inTable && /\d/.test(rest)))) return {...common, value: null, currency: code, marker: '', unreadable: true, text: rest};
      continue;
    }
    const value = kind && reductions.has(kind) ? -Math.abs(amount.value) : amount.value;
    return {...common, value, currency: amount.currency || code, marker: amount.marker};
  }
  return null;
}

/** "1 USD = 18.25 ZAR", "Exchange rate (USD/ZAR): 18.25", "Rate of exchange: 18.25" → {base, quote, rate, decimals}. */
export function readExchangeRate(row) {
  const text = row.trim();
  const pair = /\b1(?:[.,]0+)?\s*([A-Z]{3})\s*=\s*([0-9][0-9.,]*)\s*([A-Z]{3})\b/.exec(text);
  const labelled = /^(?:(?:exchange|conversion|fx|currency)\s+rate|rate\s+of\s+exchange)\b\s*(?:\(?\s*([A-Z]{3})\s*(?:\/|to|→|->)\s*([A-Z]{3})\s*\)?)?\s*[:=]?\s*([0-9][0-9.,]*)?/i.exec(text);
  const [base, digits, quote] = pair ? [pair[1], pair[2], pair[3]] : labelled ? [labelled[1] || '', labelled[3], labelled[2] || ''] : [];
  if (!digits || (!pair && !labelled) || (base && (!isCurrency(base.toUpperCase()) || !isCurrency(quote.toUpperCase())))) return null;
  const rate = readMoney(digits.replace(/[.,]$/, ''), 8)?.value;
  if (!(rate > 0)) return null;
  const decimals = (/[.,](\d+)$/.exec(digits.replace(/[.,]$/, ''))?.[1].length) ?? 0;
  return {base: base.toUpperCase(), quote: quote.toUpperCase(), rate, decimals, sourceText: text};
}
