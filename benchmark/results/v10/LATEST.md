# Controlled accuracy benchmark v10

Original baseline engine revision: `b84fa0be0ecf22a0977e58b9a91d05cc98bcabaa`. Synthetic, hand-authored diagnostic set; not a representative customer sample or OCR benchmark. Original baseline is preserved separately. This report measures the current engine hashes recorded in latest.json. Both datasets have been evaluated before. This run retains the historical labels, including the invalid-total rejection label that predates arithmetic discrepancies. It measures regression against fixed fixtures.

## Dataset and method

Exactly 30 documents: 20 invoices, 6 purchase orders and 4 credit notes. JSON is the test input; TXT is a readable representation of the same documents, not another 30 observations and not an inbox import fixture. Ground truth is separate from inputs and fixed before the run. Six duplicate pairs are positive; all other pairs among the 20 invoices are negative. Each invoice is also compared with its assigned PO (20 comparisons). Document observations are reused and are not statistically independent. Supplier aliases/typos are known identities in this fictional ground truth.

## Results

| Measure | Result |
|---|---|
| Duplicate recall | 6/6 (100.0%) |
| Duplicate precision | 6/6 (100.0%) |
| Duplicate false positives | 0/184 (0.0%) |
| Pairwise duplicate accuracy | 190/190 (100.0%) |
| PO comparison exact classifications | 18/20 |
| Issues detected or blocked | 8/8 |
| False alarms on clean PO comparisons | 1/12 |
| Explanation rubric passed | 18/20 |
| Typo reviews resolved after explicit synthetic human confirmation | 1/1 |
| Credit notes safely rejected by invoice validator | 4/4 |
| Credit-specific rejection explanation | 4/4 |

The many negative pairs inflate pairwise accuracy. Recall and the missed-pair list are more useful for judging duplicate detection. Credit-note processing is **unsupported**; rejection is a boundary check, not successful reconciliation.

Automatic metrics retain supplier-review deferrals as nonmatches; the separate human-confirmation count is not automatic accuracy.

## Duplicate errors

None.

## Comparison and explanation errors

- I11 / P5: expected matched, got supplier_review. Synthetic supplier typo represents the same supplier (master identity ground truth). Engine: Similar supplier names require identity review. Verify supplier records before comparing these documents.
- I16 / P4: expected invalid_total, got discrepancy. Stated total 580 disagrees with computed 520. Engine: See raw comparison.

## Explanation rubric

A passing discrepancy must identify every changed SKU, source line numbers, exact quantities and prices, line differences, tax difference and net amount, with matching facts in the generated draft. Invalid-document explanations must name the expected error category. Clean results must have no changed lines or tax. This is deterministic factual checking, not a subjective judgment of readability. Full outputs, draft text, labels and every pair decision are in latest.json.

## Reproduce

Run from the repository root with Node 18+: `node benchmark/run.mjs benchmark`. No dependencies or network are needed. Regenerate identical fixtures with `node benchmark/generate.mjs`. Ground-truth, input and engine SHA-256 hashes are recorded in latest.json. Repeat runs are byte-for-byte deterministic. The runner exits successfully when measurement completes, even if the product misses cases; structural or invariance failures stop execution. Do not change labels to conceal failures.

## Limits and next work

- Only structured engine behavior is measured. PDF/image OCR, actual uploads, credit-note intake across file formats, persistence and multi-user race conditions need separate tests.
- Fix identified failures, preserve this baseline, then evaluate a new unseen holdout dataset before claiming improved customer accuracy.
- Four positive-magnitude credit notes reference original invoices. Credit-specific message quality is measured separately; no credit application or balance netting is evaluated.
- Queue order and mixed queued/approved status produce the same duplicate pairs. This does not test simultaneous server uploads.
