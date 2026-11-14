# Controlled accuracy benchmark v1

Baseline: `b84fa0be0ecf22a0977e58b9a91d05cc98bcabaa`. Synthetic, hand-authored diagnostic set; not a representative customer sample or OCR benchmark. Production engines were not modified or tuned for this run.

## Dataset and method

Exactly 30 documents: 20 invoices, 6 purchase orders and 4 credit notes. JSON is the test input; TXT is a readable representation of the same documents, not another 30 observations and not an inbox import fixture. Ground truth is separate from inputs and fixed before the run. Six duplicate pairs are positive; all other pairs among the 20 invoices are negative. Each invoice is also compared with its assigned PO (20 comparisons). Document observations are reused and are not statistically independent. Supplier aliases/typos are known identities in this fictional ground truth.

## Results

| Measure | Result |
|---|---|
| Duplicate recall | 4/6 (66.7%) |
| Duplicate precision | 4/4 (100.0%) |
| Duplicate false positives | 0/184 (0.0%) |
| Pairwise duplicate accuracy | 188/190 (98.9%) |
| PO comparison exact classifications | 18/20 |
| Issues detected or blocked | 8/8 |
| False alarms on clean PO comparisons | 2/12 |
| Explanation rubric passed | 18/20 |
| Credit notes safely rejected by invoice validator | 4/4 |
| Credit-specific rejection explanation | 0/4 |

The many negative pairs inflate pairwise accuracy. Recall and the missed-pair list are more useful for judging duplicate detection. Credit-note processing is **unsupported**; rejection is a boundary check, not successful reconciliation.

## Duplicate errors

- FN: I04 / I10. 
- FN: I06 / I12. 

## Comparison and explanation errors

- I08 / P2: expected matched, got vendor_mismatch. Verified supplier alias represents the same synthetic supplier; prefix is harmless. Engine: Vendor mismatch. Select documents from the same vendor.
- I11 / P5: expected matched, got vendor_mismatch. Synthetic supplier typo represents the same supplier (master identity ground truth). Engine: Vendor mismatch. Select documents from the same vendor.

## Explanation rubric

A passing discrepancy must identify every changed SKU, source line numbers, exact quantities and prices, line differences, tax difference and net amount, with matching facts in the generated draft. Invalid-document explanations must name the expected error category. Clean results must have no changed lines or tax. This is deterministic factual checking, not a subjective judgment of readability. Full outputs, draft text, labels and every pair decision are in baseline.json.

## Reproduce

Run from the repository root with Node 18+: `npm run benchmark`. No dependencies or network are needed. Regenerate identical fixtures with `npm run benchmark:generate`. Ground-truth, input and engine SHA-256 hashes are recorded in baseline.json. Repeat runs are byte-for-byte deterministic. The runner exits successfully when measurement completes, even if the product misses cases; structural or invariance failures stop execution. Do not change labels to conceal failures.

## Limits and next work

- Only structured engine behavior is measured. PDF/image OCR, actual uploads, credit-note intake across file formats, persistence and multi-user race conditions need separate tests.
- Fix identified failures, preserve this baseline, then evaluate a new unseen holdout dataset before claiming improved customer accuracy.
- Four positive-magnitude credit notes reference original invoices. The current validator rejects their type with a generic invoice message; no credit application or balance netting is evaluated.
- Queue order and mixed queued/approved status produce the same duplicate pairs. This does not test simultaneous server uploads.
