# PR #23 financial extraction follow-up

## Discrepancy and reviewer checks

On case-25.png, the two printed rows are 5 × £12 = £60 and 1 × £13 = £13. They sum to £73 against the printed £76 subtotal. Chromium now retains the observed quantities, prices and amounts, and flags the £3 difference. Regrouping OCR words had lost their confidence scores. Extraction now carries those scores forward and favors candidates with complete source rows.

Cases 05, 21 and 37 contain multiple tax rates without a printed basis for each rate. The reviewer is asked to verify unknown taxable bases. A mismatch with an assumed subtotal no longer counts as an established financial discrepancy. Explicit tax bases and reconciliation of printed totals still undergo arithmetic checks.

A missing row set, partial printed row, unassigned table text or line-to-subtotal difference now requires a separate line-item review. In Chromium, the general confirmation alone could not submit case 25. Editing the quantity reset the line confirmation. Confirming the source rows allowed intake with the reason recorded and the financial discrepancy still visible. Server validation also retains the extraction-review hold for unresolved source data.

## Regression results

The original 48-document answer key and the Kraken scorer were reused. These fixtures have now informed development.

| Chromium, 48 source files | Earlier PR | Follow-up |
|---|---:|---:|
| Genuine discrepancies detected | 5/6 | 6/6 |
| False discrepancy alerts | 3 | 0 |
| Correct quantity / correct unit price | 84/90 each | 84/90 each |
| Correct printed line amount | 90/90 | 90/90 |

The six provisional column swaps across three headerless documents still require field confirmation. The separate Node run detected 6/6 genuine discrepancies with zero false alerts, read 82/90 quantities and prices, and produced 6/6 expected tax proposals. Both 30-document structured packs and the reissue benchmark ran. The frontend suite passed 187 tests, the backend passed 540 tests, and TypeScript typechecking passed. [Browser and Node records](../../benchmark/phase0-financial/followup/) · [Structured results](../../benchmark/results/v8/LATEST.md) · [Structured holdout](../../benchmark/holdout/results/v8/LATEST.md)

## Available image retests

| Input tested in Chromium | Result |
|---|---|
| Juliana reconstruction | Read four rows, $870 subtotal, $87 tax and $957 total. |
| Morgan reconstruction with percentage-only tax | Read five rows, $900 subtotal and $990 total. Left printed tax unknown and proposed $90 for confirmation. Final SKU also required confirmation. |
| Repository Morgan sample with printed tax | Read five rows, $900 subtotal, $90 printed tax and $990 total. PO reference and final SKU required confirmation. |

The customer’s original Morgan and Juliana uploads were unavailable. The repository Morgan sample and both reconstructions are synthetic. [Image outputs](../../benchmark/phase0-financial/followup/image-retests.json)

## Kraken OCR investigation

All 181 files were rerun against the same upstream key and scorer. Line-item F1 compares the extracted descriptions and amounts with the answer key. A score of 1.00 can coexist with an unreadable quantity or unit price, which still requires reviewer confirmation.

| Document | Earlier PR F1 | Follow-up F1 | Finding |
|---|---:|---:|---|
| handwritten-invoice-book-poor-8 | 0.50 | 0.67 | Excluded a malformed VAT summary from the table. A handwritten item is still missing. |
| photo-low-light-moderate | 0.75 | 1.00 | Retained the aligned price and amount when the quantity was unreadable. |
| photo-shadow-moderate | 0.25 | 1.00 | Read the space-grouped amount in its labeled column. |
| photo-low-res-mild | 0.25 | 1.00 | Used the surviving price and amount headings to anchor the columns. |
| scan-noise-severe | 0.33 | 1.00 | Kept the aligned extended amount when both factors were unreadable and retained the percentage charge as a line. |
| scan-stamp-moderate | 0.29 | 0.86 | Preserved the numeric description suffix and limited wrapped descriptions to their own column. |

Across the corpus, 17 documents improved in line F1 and 1 declined relative to the prior PR. Fully correct line sets increased from 118 to 132 of 179. Mean line F1 increased from 0.728 to 0.766. Exact line counts were 147/179 and correct key fields were 1,297/1,576. All five inconsistent invoices and both multi-invoice inputs were flagged. False flags on consistent documents were 2/172, compared with 3/172 on the earlier PR. Three documents exceeded the existing five-page limit.

The one decline was photo-annotations-mild (0.86 to 0.75). OCR recovered the fourth description but misread the engine-oil amount as 3,506.76 against the printed 3,596.76.

[Per-document comparison](../../benchmark/phase0-financial/followup/kraken-documents.csv) · [Raw predictions](../../benchmark/phase0-financial/followup/kraken-predictions.json.gz) · [Upstream scores](../../benchmark/phase0-financial/followup/kraken-scores.json.gz)

To reproduce the 48-document runs, use the environment described in the [original report](README.md) and pass `--followup` to both `unseen/evaluate.mjs` and `unseen/browser.mjs`. The follow-up Node run verifies the v8 engine hashes before evaluation.
