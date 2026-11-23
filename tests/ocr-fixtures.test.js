// Recorded Tesseract rows for synthetic invoice images (tests/fixtures/ocr). Regenerate the images
// with scripts/make-ocr-fixtures.mjs; the rows were read from them with the app's ocrRows().
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseExtractedText} from '../dist/extraction.js';

const load = name => {
  const read = file => JSON.parse(readFileSync(new URL(`./fixtures/ocr/${name}.${file}`, import.meta.url)));
  const rows = read('rows.json');
  return {expected: read('json'), d: parseExtractedText(rows.map(r => r.text).join('\n'), 'invoice', rows)};
};

for (const name of ['morgan-maxwell', 'holdout-reordered']) {
  test(`${name}: OCR columns keep descriptions and amounts apart`, () => {
    const {expected, d} = load(name);
    assert.equal(d.vendor, expected.vendor);
    assert.equal(d.number, expected.number);
    assert.deepEqual([d.subtotal, d.tax, d.total], [expected.subtotal, expected.tax, expected.total]);
    assert.equal(d.lines.length, expected.lines.length);
    expected.lines.forEach((want, i) => {
      const got = d.lines[i];
      assert.equal(got.description, want.description, `line ${i + 1} description`);
      assert.doesNotMatch(got.description, /\d+\.\d{2}/, `line ${i + 1} description holds no amount`);
      assert.deepEqual([got.quantity, got.unitPrice, got.amount], [want.quantity, want.unitPrice, want.amount], `line ${i + 1} numbers`);
      // An OCR-confused code is offered for confirmation rather than kept or changed silently.
      if (got.sku !== want.sku) {
        const field = d.extraction.fields[`lines.${i}.sku`];
        assert.equal(field.needsConfirmation, true, `line ${i + 1} sku ${got.sku}`);
        assert.ok(field.candidates.some(c => c.value === want.sku));
      }
    });
    assert.equal(d.arithmeticReview.contradictions.length, 0);
  });
}

test('an OCR quantity missing its decimal point is uncertain, not a contradiction', () => {
  const text = ['Description Hours Rate Amount', 'Hedge trimming 25 $60.00 $150.00', 'Leaf removal 4 $45.00 $180.00', 'Subtotal $330.00', 'Total Due $330.00'];
  const ocr = text.map((t, i) => ({text: t, page: 1, row: i + 1, method: 'ocr', ocrConfidence: 95}));
  const d = parseExtractedText(text.join('\n'), 'invoice', ocr);
  assert.equal(d.arithmeticReview.contradictions.length, 0);
  const field = d.extraction.fields['lines.0.quantity'];
  assert.equal(field.needsConfirmation, true);
  assert.deepEqual(field.candidates.map(c => c.value), [2.5, 25]);
  // The same numbers from a text PDF are a real contradiction.
  assert.ok(parseExtractedText(text.join('\n'), 'invoice').arithmeticReview.contradictions.length > 0);
});

test('an OCR zero in a PO reference is offered for confirmation, letter O first', () => {
  const {d} = load('morgan-maxwell');
  const field = d.extraction.fields.poNumber;
  assert.equal(d.poNumber, 'P0-2030-077');
  assert.equal(field.needsConfirmation, true);
  assert.deepEqual(field.candidates.map(c => c.value), ['PO-2030-077', 'P0-2030-077']);
});
