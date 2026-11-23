// Phase 0 holdout: synthetic documents drawn after the extraction and matching code was frozen.
// Usage: node benchmark/phase0-holdout/run.mjs [code root] [label]   (defaults to this repository)
// OCR runs Tesseract in Node (PSM 3, then PSM 6 if no total was read). The browser adds canvas
// retries that do not run here, so these results are a lower bound for the browser path.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(here, '..', '..'));
const load = p => import(pathToFileURL(path.join(root, p)).href);
const {ocrRows} = await load('dist/ocr-layout.js');
const {parseExtractedText} = await load('dist/extraction.js');
const {compareDocuments} = await load('dist/matching-engine.js');
const T = (await load('node_modules/tesseract.js/src/index.js')).default;

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameMoney = (a, b) => a == null || b == null ? a === b : Math.abs(a - b) < 0.005;

// Extraction: each invoice image against its answer key.
const worker = await T.createWorker('eng', 1, {cachePath: process.env.TESSERACT_CACHE});
const read = async (file, mode) => {
  await worker.setParameters({tessedit_pageseg_mode: mode});
  const rows = ocrRows((await worker.recognize(file, {}, {text: true, blocks: true})).data, 1);
  return parseExtractedText(rows.map(r => r.text).join('\n'), 'invoice', rows);
};
const extraction = [];
for (const file of fs.readdirSync(here).filter(f => f.endsWith('.png')).sort()) {
  const expected = JSON.parse(fs.readFileSync(path.join(here, file.replace(/\.png$/, '.json'))));
  let d = await read(path.join(here, file), '3');
  if (d.total == null) { const retry = await read(path.join(here, file), '6'); if (retry.total != null) d = retry; }
  const used = new Set();
  const pairs = expected.lines.filter(want => {
    const i = d.lines.findIndex((got, j) => !used.has(j) && norm(got.description) === norm(want.description) && sameMoney(got.amount, want.amount));
    if (i >= 0) used.add(i);
    return i >= 0;
  }).length;
  extraction.push({
    document: file.replace(/\.png$/, ''),
    vendor: norm(d.vendor) === norm(expected.vendor),
    number: norm(d.number) === norm(expected.number),
    subtotal: sameMoney(d.subtotal, expected.subtotal),
    tax: sameMoney(d.tax, expected.tax),
    total: sameMoney(d.total, expected.total),
    lineCount: d.lines.length === expected.lines.length,
    pairs: `${pairs}/${expected.lines.length}`,
    amountsInDescriptions: d.lines.filter(l => /\d[\d,]*\.\d{2}/.test(l.description)).length,
    contradictions: d.arithmeticReview?.contradictions?.length ?? 0,
  });
}
await worker.terminate();

// Matching: invoice and PO pairs that use different item-code conventions.
const doc = (type, lines) => ({type, number: 'PO-H', vendor: 'Holdout Supplier', poNumber: 'PO-H', currency: 'USD', lines,
  tax: 0, total: Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice * 100, 0)) / 100});
const line = (sku, description, quantity, unitPrice) => ({sku, description, quantity, unitPrice});
const matching = [
  {name: 'prefix codes, one price change', invoice: [line('CHR-10', 'Office chair, mesh', 4, 129), line('DSK-20', 'Standing desk 60in', 2, 410)],
    po: [line('CH-10', 'Office chair (mesh)', 4, 119), line('DK-20', 'Standing desk 60in', 2, 410)], pairs: [[1, 1], [2, 2]], differenceCents: 4000},
  {name: 'unrelated item sharing one word', invoice: [line('BNS-1', 'Banner stand, retractable', 1, 85)],
    po: [line('BN-1', 'Vinyl banner 2x6m', 1, 85)], pairs: [], differenceCents: null},
  {name: 'quantity change under different codes', invoice: [line('TNR-5', 'Toner cartridge black', 6, 52)],
    po: [line('T-5', 'Toner cartridge, black', 5, 52)], pairs: [[1, 1]], differenceCents: 5200},
  {name: 'exact SKUs stay exact', invoice: [line('PAP-A4', 'Copy paper A4', 10, 6.5), line('PEN-BL', 'Blue pens (12)', 3, 4)],
    po: [line('PAP-A4', 'Copy paper A4', 10, 6.5), line('PEN-BL', 'Blue pens (12)', 3, 4)], pairs: [[1, 1], [2, 2]], differenceCents: 0},
  {name: 'different dimensions are not paired', invoice: [line('PST-A1', 'Poster 60x90cm', 10, 12)],
    po: [line('PS-A1', 'Poster 30x45cm', 10, 12)], pairs: [], differenceCents: null},
];
const results = matching.map(m => {
  const first = compareDocuments(doc('invoice', m.invoice), {...doc('purchase_order', m.po)});
  const suggested = first.pendingLineMatches.map(s => [s.invoiceLine, s.poLine]);
  const key = p => p.join(':');
  const correct = suggested.filter(p => m.pairs.some(q => key(q) === key(p))).length;
  const wrong = suggested.length - correct;
  // Confirm exactly the expected pairs, as a reviewer would, and read the verified difference.
  const confirmed = compareDocuments(doc('invoice', m.invoice), doc('purchase_order', m.po),
    {lineDecisions: m.pairs.map(([invoiceLine, poLine]) => ({invoiceLine, poLine, decision: 'confirm'}))});
  const difference = m.pairs.length ? confirmed.lines.filter(l => l.invoiceLine && l.poLine).reduce((s, l) => s + l.differenceCents, 0) : null;
  const exactOnly = first.lines.filter(l => l.matchBasis === 'exact_sku').length;
  return {case: m.name, expectedPairs: m.pairs.length, suggestedCorrect: correct + exactOnly, suggestedWrong: wrong,
    differenceCents: difference, expectedDifferenceCents: m.differenceCents, differenceRight: difference === m.differenceCents};
});

// Record which code ran without writing local paths into the results.
const report = {run: new Date().toISOString(), root: process.argv[3] || (process.argv[2] ? 'external checkout' : 'this repository'), extraction, matching: results};
fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.table(extraction);
console.table(results);
