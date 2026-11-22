const symbols = {'US$':'USD','USD$':'USD','CA$':'CAD','C$':'CAD','AU$':'AUD','A$':'AUD','NZ$':'NZD','HK$':'HKD','S$':'SGD','N$':'NAD','€':'EUR','£':'GBP','₹':'INR'};
const codes = new Set(typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('currency') : ['USD','CAD','AUD','NZD','SGD','HKD','EUR','GBP','JPY','CHF','INR','CNY','MXN','NAD','ZAR','ZMW']);
export const isCurrency = code => codes.has(code);

export function readMoney(input, maxDecimals = 2) {
  const source = String(input ?? '').trim();
  const match = source.match(/^([+-])?\s*([A-Za-z]{1,3}\s*\$|[A-Za-z]{1,3}|[$€£₹])?\s*([+-]?[0-9](?:[0-9., '\u00a0\u202f’]*[0-9])?)\s*([A-Za-z]{3}|[$€£₹])?$/u);
  if (!match || (match[2] && match[4]) || (match[1] && /^[+-]/.test(match[3]))) return null;
  const marker = (match[2] || match[4] || '').replace(/\s+/g,'').toUpperCase();
  const currency = symbols[marker] || (isCurrency(marker) ? marker : '');
  if (marker && !currency && !['$','R','K'].includes(marker)) return null;

  const sign = (match[1] || match[3]).startsWith('-') ? -1 : 1;
  const number = match[3].replace(/^[+-]/,'').replace(/[\u00a0\u202f]/g,' ').replace(/’/g,"'");
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

const prefixes = [
  ['subtotalExclusive', /^(?:total\s+exclusive(?:\s+of\s+(?:vat|tax))?|(?:net|taxable)\s+(?:amount|total)|sub\s*total\s*(?:\(?(?:excl(?:usive)?\.?)(?:\s+(?:vat|tax))?\)?))\b/i],
  ['subtotal', /^sub\s*total\b/i],
  ['tax', /^(?:total\s+vat|(?:[A-Z]{2}\s+)?sales\s+tax|vat(?:\s+amount)?|tax|mwst|ust|gst|hst)\b/i],
  ['total', /^(?:(?:grand|invoice)\s+total|total(?:\s+(?:due|payable))?|amount\s+(?:due|payable)|balance\s+due)\b/i],
  ['shipping', /^(?:shipping(?:\s+(?:and|&)\s+handling)?|freight|delivery|s\s*&\s*h|handling|service(?=\s+(?:charge|fee)))(?:\s+(?:charge|fee))?\b/i],
  ['discount', /^(?:(?:(?:less|total|loyalty|trade|early\s+payment)\s+)?discount\b|promo[- ]+[\w-]+)/i]
];

export function readSummary(row, inTable) {
  for (const [key, pattern] of prefixes) {
    const label = row.match(pattern);
    if (!label) continue;
    // A freight/discount table row may contain quantity, rate and amount.
    if (inTable && ['shipping','discount'].includes(key) && row.trim().split(/ {2,}|\t/).length > 2) return null;
    let rest = row.slice(label[0].length).trim().replace(/^:\s*/,'');
    const rate = key === 'tax' && rest.match(/^\(?\s*(\d+(?:[.,]\d+)?)\s*%\s*\)?/);
    if (rate) rest = rest.slice(rate[0].length).trim();
    const included = /^(?:\((?:vat\s+|tax\s+)?incl(?:uded|usive)?\.?\)|included\s+in\s+total)/i.exec(rest);
    if (included) rest = rest.slice(included[0].length).trim();
    const partial = /^on\s+(?:fees|services|labour|labor)\b/i.exec(rest);
    if (partial) rest = rest.slice(partial[0].length).trim();
    const taxZero = /^\(?\s*zero[- ]rated\s*\)?/i.exec(rest);
    if (taxZero) rest = rest.slice(taxZero[0].length).trim();
    if (key==='shipping') rest=rest.replace(/^\([^)]*\)\s*/,'');
    const code = rest.match(/^\(([A-Z]{3})\)/);
    if (code) rest = rest.slice(code[0].length).trim();
    const amount = readMoney(rest.replace(/^:\s*/,''));
    if (!amount) continue;
    return {key,value:key==='discount'?Math.abs(amount.value):amount.value,
      currency:amount.currency || (code && isCurrency(code[1]) ? code[1] : ''),
      marker:amount.marker,included:!!included,rate:rate&&!partial?Number(rate[1].replace(',','.')):null};
  }
  return null;
}
