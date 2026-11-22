// Read identity fields independently of table rows. A PDF/OCR baseline can contain
// the buyer block on the left and the invoice or PO reference on the right.
const reference = String.raw`(?:number|num\.?|no\.?|ref(?:erence)?\.?|id|#)`;
const po = String.raw`(?:purchase\s+order|p\.?\s*o\.?)`;
const patterns = {
  vendor: String.raw`(?:vendor|supplier|seller)(?:\s+(?:name|company))?|issued\s+by|billed\s+by|bill\s+from|sold\s+by|from`,
  number: String.raw`(?:invoice|inv\.?|document|doc\.?)\s*${reference}|invoice(?=\s*[:#]|\s+[\w/-]*\d)`,
  poNumber: String.raw`${po}\s*${reference}|${po}(?=\s*[:#]|\s+[\w/-]*\d|\s*$)`,
  currency: String.raw`(?:invoice\s+)?currency(?:\s+code)?`,
  payee: String.raw`(?:bank\s+)?account\s+(?:holder|name)|payee(?:\s+name)?|beneficiary(?:\s+name)?`,
  other: String.raw`(?:bill(?:ed)?\s+to|ship(?:ped)?\s+to|customer(?:\s+name)?|supplier\s+id|vendor\s+id|invoice\s+date|due\s+date|account\s+(?:no\.?|number)|payment\s+terms)`
};
const order = ['other', 'number', 'poNumber', 'currency', 'payee', 'vendor'];
const combined = order.map(key => '(' + patterns[key] + ')').join('|');
const labels = new RegExp(String.raw`(?:^|\s)(?:${combined})(?=\s|[:#=]|(?<=[.#])\d|$)`, 'gi');
const id = /^[\p{L}\d][\p{L}\d./_-]*$/u;
const moneyCodes = new Set(typeof Intl.supportedValuesOf === 'function'
  ? Intl.supportedValuesOf('currency') : ['USD','CAD','AUD','NZD','SGD','HKD','EUR','GBP','JPY','CHF','INR','CNY','MXN']);
const currencySymbols = {'US$':'USD','USD$':'USD','CA$':'CAD','C$':'CAD','AU$':'AUD','A$':'AUD','NZ$':'NZD','HK$':'HKD','S$':'SGD','€':'EUR','₹':'INR'};
function parts(row) {
  const tokens = row.tokens || [];
  if (!tokens.length) return [{text: row.text.trim()}];
  const chunks = [];
  let right;
  for (const token of tokens) {
    const gap = token.x - right;
    if (!chunks.length || gap > Math.max(18, 3 * token.width / Math.max(1, token.text.length))) {
      chunks.push({text: token.text.trim(), x: token.x});
    } else {
      chunks.at(-1).text += ' ' + token.text.trim();
    }
    right = token.x + token.width;
  }
  return chunks;
}
function validValue(key, value) {
  if (!value || /^(?:invoice|purchase order|payment information|billed to|ship to|total|subtotal)$/i.test(value) || /^(?:n\/?a|none|not applicable|not provided|unknown|[-–—]+)$/i.test(value)) return '';
  if (key === 'number' || key === 'poNumber') {
    const candidate = value.split(/\s{2,}|\s+\|/)[0].trim();
    return (id.test(candidate) || /^(?:PO|INV)[ -]\d[\w./-]*$/i.test(candidate)) && !/^(?:number|no\.?|ref|date|total|information)$/i.test(candidate) ? candidate : '';
  }
  if (key === 'currency') return moneyCodes.has(value.toUpperCase()) ? value.toUpperCase() : '';
  return /\p{L}/u.test(value) && !/^[\d+]|@/.test(value) ? value : '';
}
function alignedValue(part, below) {
  if (part.x == null || below[0]?.x == null) return below.length === 1 ? below[0] : null;
  return below.filter(p => Math.abs(p.x - part.x) <= 16).sort((a,b) => Math.abs(a.x-part.x)-Math.abs(b.x-part.x))[0];
}
export function readDocumentMetadata(rows, kind, fields, set) {
  const columns = rows.map(parts);
  const payees = [], headings = [], dollarRows = [];
  let inBuyerBlock = false;
  for (const [i, row] of rows.entries()) {
    const cells = columns[i];
    for (const [j, cell] of cells.entries()) {
      const matches = [...cell.text.matchAll(labels)].filter(match => {
        if (!match.index) return true;
        // A generic role word inside a company name is not another label.
        const role = match[0].trim();
        return !/^(?:vendor|supplier|seller|from|customer|currency)$/i.test(role)
          || /^\s*[:#=]/.test(cell.text.slice(match.index + match[0].length));
      });
      for (const [n, match] of matches.entries()) {
        const key = order[match.slice(1).findIndex(v => v !== undefined)];
        if (key === 'other') {
          if (/bill(?:ed)?\s+to|ship(?:ped)?\s+to|customer/i.test(match[0])) inBuyerBlock = true;
          continue;
        }
        const remainder = cell.text.slice(match.index + match[0].length, matches[n+1]?.index).trim();
        let value = remainder.replace(/^[:#=–-]\s*/, '').trim();
        let source = row;
        if (!remainder || /^[:#=–-]$/.test(remainder)) {
          const adjacent = cells[j+1];
          const below = rows[i+1]?.page === row.page && alignedValue(cell, columns[i+1]);
          const next = adjacent && ![...adjacent.text.matchAll(labels)].length ? adjacent : below;
          if (!next || [...next.text.matchAll(labels)].length) continue;
          value = next.text.trim();
          if (next === below) source = {...row, sourceRows:[row,rows[i+1]]};
        } else if (key === 'vendor' && !/^[:#=–-]/.test(remainder)
            && !/name|issued by|sold by|billed by/i.test(match[0]) && match.index !== 0) continue;
        value = validValue(key, value);
        if (!value) continue;
        if (key === 'payee') payees.push({value, source});
        else set(key, value, source);
      }
      const value = cell.text.trim();
      if (i < 6 && !inBuyerBlock && !matches.length && /\b(?:LLC|Ltd|Limited|Inc|GmbH|Corporation|Company|Co)\b\.?$/i.test(value)) headings.push({value, source:row});
    }
    // Standalone document titles are common. Only use a following identifier,
    // never a buyer, a date, a street address or the word "Invoice" itself.
    if (/^invoice$/i.test(row.text.trim()) && rows[i+1]?.page === row.page && /^[\w/-]*\d[\w/-]*$/.test(rows[i+1].text.trim()) && !/^\d{4}-\d\d-\d\d$/.test(rows[i+1].text.trim())) {
      set('number', rows[i+1].text.trim(), {...row, sourceRows:[row,rows[i+1]]}, 'uncertain');
    }
    const t = row.text;
    for (const m of t.matchAll(/\b([A-Z]{3})(?=\s*[$€£]?\s*\d)|\d[\d,.]*\s+([A-Z]{3})\b/g)) {
      const code = m[1] || m[2];
      if (moneyCodes.has(code)) set('currency', code, row);
    }
    const totalCode = t.match(/\b(?:total|amount due|balance due)\s*\(([a-z]{3})\)/i)?.[1]?.toUpperCase();
    if (totalCode && moneyCodes.has(totalCode)) set('currency', totalCode, row);
    for (const m of t.matchAll(/(?:\b(?:USD|US|CA|C|AU|A|NZ|HK|S)\$|[€₹])(?=\s*\d)/g)) set('currency',currencySymbols[m[0]],row);
    if (/\$\s*\d/.test(t)) dollarRows.push(row);
  }
  if (!fields.vendor && headings.length === 1) set('vendor',headings[0].value,headings[0].source,'uncertain','Possible supplier from the document heading. Confirm the issuer.');
  if (!fields.vendor && kind === 'invoice' && new Set(payees.map(p=>p.value)).size === 1) {
    set('vendor',payees[0].value,payees[0].source,'uncertain','Payment recipient shown on the document. Confirm this is also the supplier.');
  }
  if (!fields.currency && dollarRows.length) {
    set('currency','',dollarRows.at(-1),'uncertain','The $ symbol is printed without a currency code. Confirm USD, CAD, AUD, or the applicable currency.');
  }
}
