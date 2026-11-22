import {isCurrency} from './invoice-money.js';
import {readInvoiceDate, findDate, scanDates, dateOrder, resolveDate} from './invoice-dates.js';

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
  customer: String.raw`(?:bill(?:ed)?\s+to|customer(?:\s+name)?)`,
  // Issue, due and other (order, delivery, period) date labels in en/fr/de/es/nl/it/pt.
  date: String.raw`(?:invoice\s+date|date\s+of\s+invoice|issue\s+date|date\s+issued|issued\s+on|issued(?=\s*[:#]|\s+\d)|billing\s+date|tax\s+point(?:\s+date)?|date\s+(?:de\s+(?:la\s+)?)?factur(?:e|ation)|date\s+d['’]\s*[ée]mission|rechnungsdatum|ausstellungsdatum|belegdatum|fecha\s+(?:de\s+)?(?:factura|emisi[oó]n|expedici[oó]n)|factuurdatum|data\s+(?:della\s+)?fattura|data\s+(?:di\s+)?emissione|data\s+documento|data\s+da\s+fatura|data\s+de\s+emiss[aã]o|(?:date|datum|fecha|data)(?=\s*[:#]|\s+\d))`,
  due: String.raw`(?:payment\s+due\s+date|due\s+date|payment\s+due|pay(?:able)?\s+by|due\s+by|due(?=\s*[:#]|\s+\d)|date\s+d['’]\s*[ée]ch[ée]ance|[ée]ch[ée]ance|date\s+limite\s+de\s+paiement|f[äa]llig(?:keitsdatum|\s+am|\s+bis)?|zahlbar\s+bis|fecha\s+(?:de\s+)?vencimiento|vencimiento|fecha\s+l[ií]mite\s+de\s+pago|vervaldatum|uiterste\s+betaaldatum|te\s+betalen\s+voor|data\s+(?:di\s+)?scadenza|scadenza|data\s+de\s+vencimento|vencimento)`,
  otherDate: String.raw`(?:(?:order|po|purchase\s+order|delivery|ship(?:ping|ment)?|dispatch|service|supply)\s+date|date\s+(?:of\s+)?(?:order|delivery|shipment|supply|service)|date\s+shipped|(?:billing|service|invoice)\s+period|period|date\s+de\s+(?:commande|livraison)|p[ée]riode|lieferdatum|leistungsdatum|bestelldatum|auftragsdatum|leistungszeitraum|fecha\s+de\s+(?:pedido|entrega)|periodo|leverdatum|besteldatum|orderdatum|data\s+(?:di\s+)?(?:consegna|ordine)|data\s+(?:de|da)\s+(?:entrega|encomenda))`,
  other: String.raw`(?:(?:ship(?:ped)?|deliver(?:ed)?)\s+to|(?:supplier|vendor)\s+(?:inv(?:oice)?\.?\s*(?:number|no\.?|#)|id)|account\s+(?:no\.?|number)|payment\s+terms)`
};
const order = ['other', 'otherDate', 'number', 'poNumber', 'currency', 'date', 'due', 'customer', 'payee', 'vendor'];
const combined = order.map(key => '(' + patterns[key] + ')').join('|');
const labels = new RegExp(String.raw`(?:^|\s)(?:${combined})(?=\s|[:#=]|(?<=[.#])\d|$)`, 'gi');
const id = /^[\p{L}\d][\p{L}\d./_-]*$/u;
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
    chunks.at(-1).right = right;
  }
  return chunks;
}
function validValue(key, value) {
  if (!value || /^(?:invoice|purchase order|payment information|billed to|ship to|total|subtotal)$/i.test(value) || /^(?:n\/?a|none|not applicable|not provided|unknown|[-–—]+)$/i.test(value)) return '';
  if (key === 'number' || key === 'poNumber') {
    const candidate = value.split(/\s{2,}|\s+\|/)[0].trim();
    return (id.test(candidate) || /^(?:PO|INV)[ -]\d[\w./-]*$/i.test(candidate)) && !/^(?:number|no\.?|ref|date|total|information)$/i.test(candidate) ? candidate : '';
  }
  if (key === 'currency') return isCurrency(value.toUpperCase()) ? value.toUpperCase() : '';
  return /\p{L}/u.test(value) && !/^[\d+]|@/.test(value) ? value : '';
}
function alignedValue(part, below) {
  if (part.x == null || below[0]?.x == null) return below.length === 1 ? below[0] : null;
  return below.filter(p => Math.abs(p.x - part.x) <= 16).sort((a,b) => Math.abs(a.x-part.x)-Math.abs(b.x-part.x))[0];
}
const labelKey = match => order[match.slice(1).findIndex(v => v !== undefined)];
// Lower rank wins: a specific invoice-date label, then a bare "Date", then the tax point.
const rank = hit => /^tax\s+point/i.test(hit.label) ? 2 : /^(?:date|datum|fecha|data)$/i.test(hit.label) ? 1 : 0;
function setDate(set, fields, hit, dayOrder, support = 'supported', note = '') {
  const resolved = resolveDate(hit.token, dayOrder);
  if (!resolved) return; // Not a calendar date (31/02/2026): never rolled over.
  const weak = hit.token.uncertain || resolved.weak || !resolved.value;
  const reason = resolved.value ? [note, resolved.reason].filter(Boolean).join(' ') : resolved.reason;
  set(hit.key, resolved.value ?? '', hit.source, weak ? 'uncertain' : support, reason);
  const field = fields[hit.key];
  if (field.sourceText !== undefined) return; // Conflict path: keep the first source.
  Object.assign(field, {sourceText: hit.token.text, label: hit.label});
  if (!resolved.value) Object.assign(field, {value: null, needsConfirmation: true, candidates: resolved.candidates});
}
function readDates(rows, hits, inferred, set, fields) {
  const dayOrder = dateOrder(rows.map(r => r.text).join('\n'));
  const best = key => {
    const list = hits.filter(h => h.key === key && resolveDate(h.token, dayOrder) !== null);
    const top = Math.min(...list.map(rank));
    return list.filter(h => rank(h) === top);
  };
  for (const hit of best('due')) setDate(set, fields, hit, dayOrder);
  const issued = best('date');
  for (const hit of issued) setDate(set, fields, hit, dayOrder);
  if (issued.length || hits.some(h => h.key === 'date')) return;
  if (inferred) return setDate(set, fields, inferred, dayOrder, 'uncertain', 'Date printed below the invoice number. Confirm it is the invoice date.');
  // ponytail: first lone date near the top; a layout-aware header model would do better.
  for (const row of rows.slice(0, 25)) {
    const found = scanDates(row.text);
    // A two-digit-year number such as a phone fragment (01.23.45) is too weak without a label.
    if (found.length !== 1 || found[0].y4 === false || findLabels(row.text).some(m => ['due', 'otherDate', 'date'].includes(labelKey(m)))) continue;
    const hit = {key: 'date', token: found[0], label: '', source: row};
    if (!resolveDate(hit.token, dayOrder)) continue;
    return setDate(set, fields, hit, dayOrder, 'uncertain', 'No date label found; this is the first lone date near the top of the document. Confirm it is the invoice date.');
  }
}
function findLabels(text) {
  return [...text.matchAll(labels)].filter(match => {
    if (!match.index) return true;
    // A generic role word inside a company name is not another label.
    const role = match[0].trim();
    return !/^(?:vendor|supplier|seller|from|customer|currency)$/i.test(role)
      || /^\s*[:#=]/.test(text.slice(match.index + match[0].length));
  });
}
export function readDocumentMetadata(rows, kind, fields, set) {
  const columns = rows.map(parts);
  const payees = [], headings = [], letterheads = [];
  let inBuyerBlock = false;
  const dateHits = [];
  let invoiceNumberPosition, inferredDate;
  for (const [i, row] of rows.entries()) {
    const cells = columns[i];
    for (const [j, cell] of cells.entries()) {
      const matches = findLabels(cell.text);
      for (const [n, match] of matches.entries()) {
        const key = labelKey(match);
        if (key === 'otherDate') continue;
        if (key === 'other') {
          if (/(?:ship(?:ped)?|deliver(?:ed)?)\s+to/i.test(match[0])) inBuyerBlock = true;
          continue;
        }
        if (key === 'customer') inBuyerBlock = true;
        const remainder = cell.text.slice(match.index + match[0].length, matches[n+1]?.index).trim();
        let value = remainder.replace(/^[:#=–-]\s*/, '').trim();
        let source = row;
        if (!remainder || /^[:#=–-]$/.test(remainder)) {
          const adjacent = cells[j+1];
          const below = rows[i+1]?.page === row.page && alignedValue(cell, columns[i+1]);
          const next = key !== 'customer' && adjacent && !findLabels(adjacent.text).length ? adjacent : below;
          if (!next || findLabels(next.text).length) continue;
          value = next.text.trim();
          if (next === below) source = {...row, sourceRows:[row,rows[i+1]]};
        } else if (key === 'vendor' && !/^[:#=–-]/.test(remainder)
            && !/name|issued by|sold by|billed by/i.test(match[0]) && match.index !== 0) continue;
        if (key === 'date' || key === 'due') {
          const token = findDate(value, row.method);
          if (token) dateHits.push({key, token, source, label: match[0].trim()});
          continue;
        }
        if (key === 'customer' && readInvoiceDate(value, row.method)) continue;
        value = validValue(key, value);
        if (!value) continue;
        if (key === 'payee') payees.push({value, source});
        else {
          set(key, value, source);
          if (key === 'number') invoiceNumberPosition = {i, cell, row};
        }
      }
      const value = cell.text.trim().replace(/\s+(?:tax\s+)?invoice$/i,'');
      const nearbyNumber = invoiceNumberPosition?.i === i - 1 && invoiceNumberPosition.row.page === row.page;
      if (kind === 'invoice' && nearbyNumber) {
        const header = invoiceNumberPosition.cell;
        // Right-aligned metadata often has a different left edge on each row.
        const sameColumn = cell.x == null ? cells.length === 1 : Math.abs(cell.right - header.right) <= 25;
        const token = sameColumn && findDate(value, row.method);
        if (token?.whole && !inferredDate) inferredDate = {key: 'date', token, label: '', source: {...row, sourceRows: [invoiceNumberPosition.row, row]}};
      }
      if (i < 6 && !inBuyerBlock && !matches.length) {
        const legalName = /\b(?:LLC|Ltd|Limited|Inc|GmbH|Corporation|Company|Co|CC|PLC|LLP|Pty|KG|AG|Sarl|BV)\b\.?$/i;
        if (legalName.test(value)) headings.push({value, source:row});
        else if (i < 3 && /^[\p{L}][\p{L} .&'’()-]+$/u.test(value) && value.split(/\s+/).length >= 2 &&
            !/\b(?:invoice|purchase order|statement|receipt|draft|bill|ship|customer|page|credit note|tax|bank|phone|email)\b/i.test(value)) {
          const nearby = rows.slice(i+1,i+6);
          if (nearby.some(r=>r.page===row.page&&/(?:@|\b(?:tel|phone|vat reg|vat no|tax id|email)\b)/i.test(r.text)) &&
              rows.slice(0,4).some(r=>r.page===row.page&&/\binvoice\b/i.test(r.text))) letterheads.push({value,source:row});
        }
      }
    }
    // Standalone document titles are common. Only use a following identifier,
    // never a buyer, a date, a street address or the word "Invoice" itself.
    if (/^invoice$/i.test(row.text.trim()) && rows[i+1]?.page === row.page && /^[\w/-]*\d[\w/-]*$/.test(rows[i+1].text.trim()) && !/^\d{4}-\d\d-\d\d$/.test(rows[i+1].text.trim())) {
      set('number', rows[i+1].text.trim(), {...row, sourceRows:[row,rows[i+1]]}, 'uncertain');
    }

  }
  readDates(rows, dateHits, inferredDate, set, fields);
  const candidates = headings.length ? headings : letterheads;
  const uniqueHeadings = new Map(candidates.map(candidate=>[candidate.value,candidate]));
  if (!fields.vendor && uniqueHeadings.size === 1) {
    const {value,source} = uniqueHeadings.values().next().value;
    set('vendor',value,source,'uncertain','Possible supplier from the document letterhead. Confirm the issuer.');
  }
  if (!fields.vendor && kind === 'invoice' && new Set(payees.map(p=>p.value)).size === 1) {
    set('vendor',payees[0].value,payees[0].source,'uncertain','Payment recipient shown on the document. Confirm this is also the supplier.');
  }
}
