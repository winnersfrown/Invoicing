import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';import {splitLineRow} from '../dist/layout-extraction.js';
import {ocrRows} from '../dist/ocr-layout.js';import {parseExtractedText} from '../dist/extraction.js';

const row = (text, order) => { const r = splitLineRow(text, order); return r && {...r}; };
const norm = s => s.replace(/\s+/g, ' ').trim();

test('price before quantity is split by arithmetic', () => {
 assert.deepEqual(row('SMM-001 Social Media Strategy Plan $100.00 1 $100.00'),
  {sku: 'SMM-001', description: 'Social Media Strategy Plan', quantity: 1, unitPrice: 100, amount: 100});
 assert.deepEqual(row('PR-330 Photo Retouching $15.00 12 $180.00'),
  {sku: 'PR-330', description: 'Photo Retouching', quantity: 12, unitPrice: 15, amount: 180});
});

test('quantity before price is split the same way', () => {
 const r = row('CNT-002 Content Creation (5 posts) 5 $100.00 500.00');
 assert.deepEqual([r.description, r.quantity, r.unitPrice, r.amount], ['Content Creation (5 posts)', 5, 100, 500]);
});

test('the SKU may follow the description', () => {
 const r = row('Brand Workshop (half day) BW-110 $640.00 1 $640.00');
 assert.deepEqual([r.sku, r.description, r.quantity, r.unitPrice, r.amount], ['BW-110', 'Brand Workshop (half day)', 1, 640, 640]);
});

test('an ambiguous pair follows the header order, and still reconciles', () => {
 // 2 x 2 = 4 either way round; the header says price comes first.
 const r = row('A-1 Widget 2 2 4', ['unitPrice', 'quantity']);
 assert.deepEqual([r.quantity, r.unitPrice, r.amount], [2, 2, 4]);
 const s = row('A-1 Widget $5.00 3 $15.00', ['sku', 'description', 'unitPrice', 'quantity', 'amount']);
 assert.deepEqual([s.quantity, s.unitPrice], [3, 5]);
});

test('money is never left in the description', () => {
 for (const text of ['SMM-001 Social Media Strategy Plan $100.00 1 $100.00', 'Photo Retouching PR-330 $15.00 12 $180.00', 'A Boxes 2 50.00 90.00']) {
  const r = row(text);
  assert.ok(r, text);
  assert.doesNotMatch(r.description, /\d[\d,]*\.\d{2}|\$/, text);
 }
});

test('an unreconcilable row keeps the printed amount instead of inventing one', () => {
 const r = row('A Boxes 2 50.00 90.00');
 assert.deepEqual([r.description, r.quantity, r.unitPrice, r.amount], ['A Boxes', 2, 50, 90]);
 const parsed = parseExtractedText('Vendor: Example\nInvoice: X\nPO reference: P\nCurrency: USD\nA Boxes 2 50.00 90.00\nTotal: 100.00', 'invoice');
 assert.equal(parsed.lines[0].amount, 90);
 assert.equal(row('Widget 7 9'), null); // two bare numbers: nothing to reconcile
 assert.equal(row('just words'), null);
});

test('a wrapped description line is appended to the row above', () => {
 const text = 'Description Item Rate Hours Line Total\nWebsite Copy Edit WC-220 $175.00 2 $350.00\n(home and about pages)\nTotal $350.00';
 const doc = parseExtractedText(`Vendor: Example\nInvoice: X\nCurrency: USD\n${text}`, 'invoice');
 assert.equal(doc.lines.length, 1);
 assert.match(doc.lines[0].description, /Website Copy Edit/);
});

// ---- OCR on real images (tesseract.js in Node) ----
const cachePath = process.env.TESSERACT_CACHE;
const ocr = {skip: !cachePath && 'set TESSERACT_CACHE to a folder holding eng.traineddata (it is downloaded on first use otherwise)'};
const skuMatch = (got, want) => got === want || (got.length === want.length && [...got].every((c, i) => c === want[i] || ('1I|l'.includes(c) && '1I|l'.includes(want[i])) || ('0O'.includes(c) && '0O'.includes(want[i]))));

async function runOcr(name) {
 const {default: Tesseract} = await import('tesseract.js');
 const worker = await Tesseract.createWorker('eng', 1, cachePath ? {cachePath} : {});
 try {
  await worker.setParameters({tessedit_pageseg_mode: '3'}); // the page mode extraction.js uses first
  const image = new URL(`./fixtures/ocr/${name}.png`, import.meta.url);
  const data = (await worker.recognize(readFileSync(image), {}, {text: true, blocks: true})).data;
  const rows = ocrRows(data, 1);
  return parseExtractedText(rows.map(r => r.text).join('\n'), 'invoice', rows);
 } finally { await worker.terminate(); }
}

for (const name of ['morgan-maxwell', 'holdout-reordered']) {
 test(`OCR columns: ${name}.png`, ocr, async t => {
  const want = JSON.parse(readFileSync(new URL(`./fixtures/ocr/${name}.json`, import.meta.url)));
  const got = await runOcr(name);
  assert.equal(got.lines.length, want.lines.length);
  want.lines.forEach((w, i) => {
   const g = got.lines[i];
   assert.equal(norm(g.description), w.description, `line ${i + 1} description`);
   assert.deepEqual([g.quantity, g.unitPrice, g.amount], [w.quantity, w.unitPrice, w.amount], `line ${i + 1} numbers`);
   assert.ok(skuMatch(g.sku, w.sku), `line ${i + 1} SKU ${g.sku} vs ${w.sku}`);
   if (g.sku !== w.sku) t.diagnostic(`SKU OCR confusion: read ${g.sku}, expected ${w.sku}`);
  });
  assert.deepEqual([got.subtotal, got.tax, got.total], [want.subtotal, want.tax, want.total]);
  assert.equal(got.number, want.number);
  assert.equal(got.vendor, want.vendor);
 });
}
