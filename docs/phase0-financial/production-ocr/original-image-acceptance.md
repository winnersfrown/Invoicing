# PR #24 original-image acceptance

## Candidate selection and payment rows

The first PR #24 revision rejected a ruled-table read of the original Morgan file because the full-page OCR read `1GS-004` while the labeled SKU cell read `IGS-004`. The same row carried the independently extracted printed amount of $150 in both reads. The fallback also interpreted a labeled payment account number as a line item.

The revised selection requires a unique match on the same page and overlapping row geometry, and protects the printed amount. A one-character I/1, O/0, S/5, B/8, or Z/2 conflict can match only when the descriptions agree and the new SKU comes from the ruled cell. This preserves the prior observation as evidence and requires confirmation, with the labeled reading offered first. Printed amount differences still prevent substitution. The match does not use calculated amounts or arithmetic agreement.

Payment and footer headings end fallback table parsing. Clear banking, registration, and contact identifiers are excluded from line extraction. Plausible line text in a footer is surfaced for review. New labeled tables and page boundaries resume item parsing. Items outside the selected ruled region are preserved.

| Morgan trace | Earlier PR #24 | Revised PR #24 |
|---|---|---|
| Ruled-table output | Read five legitimate rows and the three printed summary amounts | Read the same five rows and three amounts |
| Candidate decision | Rejected because the $150 row had an OCR lookalike SKU conflict | Accepted after matching the row geometry, description and $150 amount |
| Payment account | Parsed as a fourth fallback item and carried into the rejected candidate | Recognized as an identifier and excluded |
| Review | Three legitimate items, a spurious payment-account row and missing subtotal and total | Five legitimate items and the printed subtotal, tax and total. Both SKU observations retained for explicit confirmation. |

## Browser extraction and review

Both original PNGs were read directly from the supplied archive. Browser upload hashes matched the extracted originals on every run. The attachment bytes and screenshots remain in the coding workspace. Chromium used the production extraction and review modules and the same pinned local OCR model. Repeated tests exercised the review dialog, verified that it blocks unresolved fields, confirmed them, and saved the reviewed extraction locally.

| Original | Main | Earlier PR #24 | Revised PR #24 |
|---|---|---|---|
| Morgan Maxwell | Three legitimate rows, reversed factors, one spurious payment row. Missing subtotal and total. | Same item and amount errors. Recovered billed-to text and warned about date order. | Five correct rows. Printed $900 subtotal, $90 tax at 10%, and $990 total. Leading zero, PO reference and billed-to details preserved. Both dates, currency and the disputed SKU remain review fields. |
| Juliana Silva Fashion | One partial row, missing subtotal and tax. Read $957 total. | Four correct rows, $870 subtotal, $87 tax, $957 total, correct PO and dates. | Preserved the four rows, amounts, dates and PO reference. The bare dollar symbol still requires confirmation. |

| Morgan printed SKU | Quantity | Unit price | Printed amount |
|---|---:|---:|---:|
| SMM-001 | 1 | $100 | $100 |
| CNT-002 | 5 | $100 | $500 |
| RPT-003 | 1 | $100 | $100 |
| IGS-004 | 3 | $50 | $150 |
| HSR-005 | 1 | $50 | $50 |

Morgan's printed due date precedes the invoice date under both supported interpretations. Chromium confirmed that the warning appears before date confirmation and remains after choosing an interpretation. The printed dates and SKU conflict remain auditable source evidence.

## Regression checks

| Check | Earlier PR #24 | Revised PR #24 |
|---|---:|---:|
| Kraken documents evaluated | 181 | 181 |
| Kraken header fields correct | 1,297/1,576 | 1,297/1,576 |
| Kraken exact item counts | 147/179 | 147/179 |
| Kraken fully correct item sets | 132/179 | 132/179 |
| Kraken mean line F1 | 0.766 | 0.766 |
| Kraken genuine and multi-invoice flags | 7/7 | 7/7 |
| Kraken false flags | 2/172 | 2/172 |
| Supplemental Chromium discrepancy flags | 6/6 | 6/6 |
| Supplemental Chromium false flags | 0/39 | 0/39 |
| Supplemental Chromium printed line amounts | 90/90 | 90/90 |
| Supplemental Chromium correct quantities and unit prices | 84/90 each | 84/90 each |
| Frontend tests | 191 passed | 195 passed |
| Backend tests | 540 passed | 540 passed |

TypeScript, the supplemental Node run, both structured suites, and reissued-reference duplicate detection also passed. Each structured suite matched six of six duplicate pairs with zero false duplicate alerts. The three Kraken invoices above the existing five-page limit remained in the evaluation. Per-document line F1 matched the earlier PR run throughout the corpus and no benchmark answer key changed.

The supplemental commands accept `--original-image-acceptance` to preserve the previous result sets. [Supplemental and Kraken outputs](../../../benchmark/phase0-financial/original-image-acceptance/) · [Structured matching](../../../benchmark/results/v10/LATEST.md) · [Structured holdout](../../../benchmark/holdout/results/v10/LATEST.md)

## Processing times

Three runs per revision. OCR and parsing times include worker startup and exclude the review interaction. The final measurements ran after the benchmark jobs finished.

| Original | Main median | Earlier PR median | Revised runs | Revised median |
|---|---:|---:|---|---:|
| Morgan Maxwell | 5.436 s | 5.898 s | 3.103, 2.594, 2.475 s | 2.594 s |
| Juliana Silva | 5.606 s | 2.443 s | 2.445, 2.467, 2.422 s | 2.445 s |

**Merge readiness.** Both original images pass and the regression results support merging after review. Morgan still requires reviewer confirmation of currency, its two date strings, and the disputed SKU.
