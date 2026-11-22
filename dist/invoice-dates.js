const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const month = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const dayFirst = new RegExp(String.raw`^(\d{1,2})\s+${month}\s+(\d{4})$`, 'i');
const monthFirst = new RegExp(String.raw`^${month}\s+(\d{1,2}),?\s+(\d{4})$`, 'i');

function utcDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value ? time : null;
}

export function readInvoiceDate(value) {
  let year, monthNumber, day;
  let uncertain = false;
  if (utcDay(value) !== null) return {value, uncertain};
  const numeric = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const first = value.match(dayFirst);
  const second = value.match(monthFirst);
  if (numeric) {
    [, monthNumber, day, year] = numeric;
    uncertain = true; // Preserve the existing US order, with a review cue.
  } else if (first || second) {
    const name = first?.[2] ?? second[1];
    day = first?.[1] ?? second[2];
    year = (first ?? second)[3];
    monthNumber = String(months.indexOf(name.slice(0,3).toLowerCase()) + 1);
  } else return null;
  const iso = `${year}-${monthNumber.padStart(2,'0')}-${day.padStart(2,'0')}`;
  return utcDay(iso) === null ? null : {value: iso, uncertain};
}

export function invoiceDateIssue(invoiceDate, dueDate) {
  const issued = utcDay(invoiceDate);
  const due = utcDay(dueDate);
  if (issued === null || due === null || due >= issued) return '';
  const days = (issued - due) / 86400000;
  return `Payment due date ${dueDate} is ${days} ${days === 1 ? 'day' : 'days'} before invoice date ${invoiceDate}. Verify both dates.`;
}
