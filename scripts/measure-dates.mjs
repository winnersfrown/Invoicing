// Measure invoice-date and due-date extraction on extracted invoice texts.
// Usage: node scripts/measure-dates.mjs <folder of .txt> [expected.json]
// expected.json (defaults to <folder>/expected.json) maps file name -> {issued, due}
// with YYYY-MM-DD or null when the document has no such date. Add "ambiguous": true
// (both fields) or ["issued"] / ["due"] for dates a person could not settle either;
// those are left out of the accuracy on clearly identifiable dates.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseExtractedText} from '../dist/extraction.js';

const [folder, expectedPath = folder && join(folder, 'expected.json')] = process.argv.slice(2);
if (!folder) {
  console.error('Usage: node scripts/measure-dates.mjs <folder of .txt> [expected.json]');
  process.exit(2);
}
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const paths = {issued: 'date', due: 'due'};
const blankCounts = () => ({expected: 0, correct: 0, blank: 0, wrong: 0, needsConfirmation: 0, confirmableFromCandidates: 0, absentAndBlank: 0, clear: 0, clearCorrect: 0});
const counts = {issued: blankCounts(), due: blankCounts()};
const misses = [];

for (const [file, want] of Object.entries(expected)) {
  const name = /\.txt$/i.test(file) ? file : file + '.txt';
  const d = parseExtractedText(readFileSync(join(folder, name), 'utf8'), 'invoice');
  for (const [key, path] of Object.entries(paths)) {
    const c = counts[key], field = d.extraction?.fields?.[path] ?? {};
    const got = d[path] || null, target = want[key] ?? null;
    const ambiguous = want.ambiguous === true || (Array.isArray(want.ambiguous) && want.ambiguous.includes(key));
    if (target) c.expected++;
    if (target && !ambiguous) c.clear++;
    let outcome;
    if (got && got === target) outcome = 'correct';
    else if (got) outcome = 'wrong';
    else if (field.needsConfirmation) outcome = 'needsConfirmation';
    else outcome = target ? 'blank' : 'absentAndBlank';
    c[outcome]++;
    if (outcome === 'correct' && target && !ambiguous) c.clearCorrect++;
    if (outcome === 'needsConfirmation' && field.candidates?.some(x => x.value === target)) c.confirmableFromCandidates++;
    if (outcome !== 'correct' && outcome !== 'absentAndBlank') misses.push(`${name} ${key}: expected ${target}, got ${got ?? (field.needsConfirmation ? 'needs confirmation [' + field.candidates.map(x => x.value).join(', ') + ']' : 'blank')}${field.sourceText ? ` from "${field.sourceText}"` : ''}`);
  }
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : 'n/a';
console.log(`Documents: ${Object.keys(expected).length}`);
for (const [key, c] of Object.entries(counts)) {
  console.log(`${key}: expected ${c.expected} | correct ${c.correct} | blank ${c.blank} | wrong ${c.wrong} | needs-confirmation ${c.needsConfirmation} (right answer among candidates: ${c.confirmableFromCandidates}) | correctly blank ${c.absentAndBlank} | accuracy on clearly identifiable dates ${c.clearCorrect}/${c.clear} = ${pct(c.clearCorrect, c.clear)}`);
}
const all = Object.values(counts).reduce((a, c) => ({n: a.n + c.clearCorrect, d: a.d + c.clear}), {n: 0, d: 0});
console.log(`Overall accuracy on clearly identifiable dates: ${all.n}/${all.d} = ${pct(all.n, all.d)}`);
if (misses.length) console.log('\nNot correct:\n' + misses.join('\n'));
