// Warnings on hand-written clean invoices (false positives) and on the same invoices with the last total
// raised by 10.00 (detections). Small labelled set; not the product owner's dataset and not a pass rate.
import {parseLayoutText} from '../dist/layout-extraction.js';
import {clean, wrong} from '../tests/money-fixtures.js';

// Uncertain conversions (within the printed rate's rounding tolerance) count as uncertain, not as a pass.
const uncertain = d => d.arithmeticReview.uncertain.length + d.arithmeticReview.conversions.filter(c => c.status === 'uncertain').length;
const rows = Object.entries(clean).map(([id, text]) => {
  const ok = parseLayoutText(text, 'invoice'), bad = parseLayoutText(wrong(text), 'invoice');
  return {id, falsePositive: ok.arithmetic.length > 0, cleanUncertain: uncertain(ok),
    detected: bad.arithmetic.length > 0, wrongUncertain: uncertain(bad), codes: bad.arithmetic.map(c => c.code).join(',') || '-'};
});
console.table(rows);
const n = rows.length;
console.log(`Clean invoices with a contradiction (false positives): ${rows.filter(r => r.falsePositive).length}/${n}`);
console.log(`Clean invoices with an uncertain result: ${rows.filter(r => r.cleanUncertain).length}/${n}`);
console.log(`Wrong invoices detected as contradictions: ${rows.filter(r => r.detected).length}/${n}`);
console.log(`Wrong invoices flagged uncertain instead: ${rows.filter(r => !r.detected && r.wrongUncertain).map(r => r.id).join(', ') || 'none'}`);
console.log(`Wrong invoices missed entirely: ${rows.filter(r => !r.detected && !r.wrongUncertain).map(r => r.id).join(', ') || 'none'}`);
