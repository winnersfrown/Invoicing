// Invoice dates: numeric (D/M/Y, M/D/Y, Y-M-D with / . -) and month names in
// English, French, German, Spanish, Dutch, Italian and Portuguese.
const monthWords = [
  'january jan janvier janv januar jän jänner enero ene januari gennaio gen janeiro',
  'february feb février fevrier févr fevr februar febrero februari febbraio fevereiro fev',
  'march mar mars märz maerz mrz marzo maart mrt março marco',
  'april apr avril avr abril aprile',
  'may mai mayo mei maggio mag maio',
  'june jun juin juni junio giugno giu junho',
  'july jul juillet juil juli julio luglio lug julho',
  'august aug août aout agosto ago augustus',
  'september sep sept septembre septiembre setiembre settembre set setembro',
  'october oct octobre oktober okt octubre ottobre ott outubro out',
  'november nov novembre noviembre novembro',
  'december dec décembre decembre déc dezember dez diciembre dic dicembre dezembro'
];
const monthOf = new Map(monthWords.flatMap((words, i) => words.split(' ').map(w => [w, i + 1])));
const englishMonths = monthWords.map(words => words.split(' ')[0].replace(/^./, c => c.toUpperCase()));
const name = `(${[...monthOf.keys()].sort((a, b) => b.length - a.length).join('|')})(?!\\p{L})\\.?`;
const datePattern = new RegExp([
  String.raw`(?<!\d)(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)`,                       // 1-4 ISO
  String.raw`(?<![\d./-])(\d{1,2})([./-])(\d{1,2})\6(\d{4}|\d{2})(?![\d])`,           // 5-8 numeric
  String.raw`(?<![\d.])(\d{1,2})(?:\.|er|st|nd|rd|th)?(?:\s*|-)(?:de\s+)?${name}(?:\s*,?\s*|-)(?:de\s+)?(\d{4}|\d{2})(?!\d)`, // 9-11 day first
  String.raw`(?<!\p{L})${name}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)`         // 12-14 month first
].join('|'), 'giu');

function utcDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value ? time : null;
}
function iso(year, month, day) {
  const full = String(year).length === 2 ? 2000 + Number(year) : Number(year);
  const value = `${full}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  return utcDay(value) === null ? null : value;
}
const spoken = value => `${Number(value.slice(8))} ${englishMonths[Number(value.slice(5,7)) - 1]}`;

// Every date-like token in the text. Numeric D/M vs M/D tokens keep both readings.
export function scanDates(text) {
  return [...String(text ?? '').matchAll(datePattern)].map(m => {
    const base = {text: m[0].trim(), index: m.index};
    if (m[1]) return {...base, kind: 'iso', value: iso(m[1], m[3], m[4])};
    if (m[5]) return {...base, kind: 'numeric', y4: m[8].length === 4, dmy: iso(m[8], m[7], m[5]), mdy: iso(m[8], m[5], m[7])};
    if (m[9]) return {...base, kind: 'dayName', value: iso(m[11], monthOf.get(m[10].toLowerCase()), m[9])};
    return {...base, kind: 'monthName', value: iso(m[14], monthOf.get(m[12].toLowerCase()), m[13])};
  });
}

// The first date at the start of a labeled value ("am 09.03.2026", "le 9 mars 2026").
export function findDate(value, method) {
  const original = String(value ?? '').trim();
  let text = original;
  if (method === 'ocr') {
    // OCR can merge the day into a misread capital J, for example "30]uly".
    text = text.replace(/^(\d{1,2})\s*\](an(?:uary)?|un(?:e)?|ul(?:y)?)(?=\s+\d{4}$)/i, '$1 J$2');
  }
  const token = scanDates(text)[0];
  const prefix = token && text.slice(0, token.index);
  if (!token || /\d/.test(prefix) || prefix.length > 15) return null;
  const whole = token.index === 0 && token.text.length === text.length;
  return text === original ? {...token, whole} : {...token, text: original, whole, uncertain: true};
}

// Day/month order from evidence: an unambiguous date elsewhere, then language, then region.
const language = /(?<!\p{L})(?:factur[ae]|factuur|fatt?ura|rechnung|datum|fecha|échéance|scadenza|vencimi?ento|vervaldatum|fällig|zahlbar|montant|betrag|importe|bedrag|importo|(?:tva|mwst|iva|btw|nif|siret)(?!\p{L}))/iu;
const usAddress = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(?:-\d{4})?\b/;
const dayFirstSignals = [
  ['VAT', /\bVAT\b/i], ['£ or GBP', /£|\bGBP\b/], ['€ or EUR', /€|\bEUR\b/],
  ['AUD, NZD, ZAR, INR or CHF', /\b(?:AUD|NZD|ZAR|INR|CHF)\b|A\$|NZ\$/],
  ['UK postcode', /\b[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}\b/],
  ['non-US phone code', /\+(?:44|33|49|34|31|39|351|32|41|43|353|61|64|27|91)\b/],
  ['non-US company form', /\b(?:Ltd|PLC|Pty|GmbH|SARL|SAS|B\.?V|S\.?p\.?A|Srl|Lda)\b/],
  ['non-US country', /\b(?:United Kingdom|England|Scotland|Ireland|France|Germany|Deutschland|Spain|España|Netherlands|Nederland|Italy|Italia|Portugal|Belgium|Australia|New Zealand|South Africa|India)\b/]
];
const monthFirstSignals = [
  ['US address', usAddress], ['USD', /\bUSD\b|US\$/], ['US sales tax', /\bsales tax\b/i],
  ['US company form', /\b(?:LLC|Inc)\b/], ['United States', /\bUnited States\b|\bUSA\b/]
];
export function dateOrder(text) {
  const votes = {numeric: {}, named: {}};
  for (const t of scanDates(text)) {
    if (t.kind === 'numeric' && t.y4 && t.dmy && !t.mdy) votes.numeric.dmy ??= t.text;
    if (t.kind === 'numeric' && t.y4 && t.mdy && !t.dmy) votes.numeric.mdy ??= t.text;
    if (t.kind === 'dayName' && t.value) votes.named.dmy ??= t.text;
    if (t.kind === 'monthName' && t.value) votes.named.mdy ??= t.text;
  }
  for (const [kind, v] of Object.entries(votes)) {
    if (v.dmy && v.mdy) break; // Dates in the document disagree; fall back to regional signals.
    const order = v.dmy ? 'dmy' : v.mdy ? 'mdy' : null;
    if (!order) continue;
    const words = order === 'dmy' ? 'day/month' : 'month/day';
    return {order, reason: kind === 'numeric'
      ? `Read as ${words}: ${v[order]} elsewhere in the document can only be ${words}.`
      : `Read as ${words}: the document writes ${v[order]} with the ${order === 'dmy' ? 'day' : 'month'} first.`};
  }
  const word = text.match(language)?.[0];
  if (word) return {order: 'dmy', reason: `Read as day/month: the document is in a day-first language ("${word}").`};
  const dmy = dayFirstSignals.filter(([, re]) => re.test(text)).map(([n]) => n);
  const mdy = monthFirstSignals.filter(([, re]) => re.test(text)).map(([n]) => n);
  if (dmy.length && !mdy.length) return {order: 'dmy', weak: true, reason: `Read as day/month from regional signals (${dmy.join(', ')}). Confirm the date.`};
  if (mdy.length && !dmy.length) return {order: 'mdy', weak: true, reason: `Read as month/day from US signals (${mdy.join(', ')}). Confirm the date.`};
  return {why: dmy.length ? `the regional signals conflict (${dmy.join(', ')} suggest day/month; ${mdy.join(', ')} suggest month/day)` : ''};
}

// Resolve a token to {value, reason?, weak?} or, when ambiguous, {value:null, candidates, reason}.
export function resolveDate(token, order = {}) {
  if (token.kind !== 'numeric') return token.value ? {value: token.value} : null;
  const {dmy, mdy} = token;
  if (!dmy || !mdy || dmy === mdy) return dmy || mdy ? {value: dmy || mdy} : null;
  if (order.order) return {value: order.order === 'dmy' ? dmy : mdy, reason: order.reason, weak: order.weak};
  return {
    value: null,
    candidates: [{value: dmy, label: `${spoken(dmy)} ${dmy.slice(0,4)} (day/month)`}, {value: mdy, label: `${spoken(mdy)} ${mdy.slice(0,4)} (month/day)`}],
    reason: `${token.text} could be ${spoken(dmy)} or ${spoken(mdy)}; ${order.why || 'no other date or regional signal in the document settles it'}. Confirm the date.`
  };
}

// Whole-value reader kept for callers that need a yes/no "is this a date" answer.
export function readInvoiceDate(value, method, order) {
  const token = findDate(value, method);
  const resolved = token?.whole && resolveDate(token, order);
  if (!resolved) return null;
  return {value: resolved.value, uncertain: Boolean(token.uncertain || !resolved.value || resolved.weak)};
}

export function invoiceDateIssue(invoiceDate, dueDate) {
  const issued = utcDay(invoiceDate);
  const due = utcDay(dueDate);
  if (issued === null || due === null || due >= issued) return '';
  const days = (issued - due) / 86400000;
  return `Payment due date ${dueDate} is ${days} ${days === 1 ? 'day' : 'days'} before invoice date ${invoiceDate}. Verify both dates.`;
}
