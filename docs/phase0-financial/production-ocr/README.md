# Production OCR follow-up

[Read the final original-image acceptance results](original-image-acceptance.md). The report below records the earlier synthetic baseline.

The branch starts from main at `a0c5eb1`, which contains PR #23. Production served an identical SHA-256 for the browser extraction module used in the baseline run. The workspace received the text brief and could display the two inline invoice images in chat. It did not receive downloadable invoice files for Chromium. The production screenshots record the reported symptoms. The exact-image reproduction, retest and before-and-after screenshots are pending. The image and screenshots committed here are from a purpose-built synthetic invoice with different names, line items and amounts.

## Investigation and fixes

| Area | Finding and change |
|---|---|
| Reversed quantity and rate | The production screenshot shows the parser's ambiguous-factor fallback. That result is consistent with the normal OCR output losing a usable header. Without the image bytes, the failing OCR pass cannot be traced to a specific mode. On the synthetic fixture the full-page pass recognized neither a usable table heading nor usable item rows. The new retry finds ruling and reads each dark heading and its body cells independently. All five heading identities must be present and unique. The printed positions determine which factor is the price. Headerless input continues through the existing confirmation workflow. |
| Border artifacts | OCR can interpret a nearby border as text during full-page extraction. The retry crops inside validated cell boundaries before OCR. Standalone letters and punctuation in the description are preserved. The exact cause of Morgan's leading “I” still needs a trace of the original file. |
| Missing financial summary | The existing regional retry needs a detected total-like row, and the old ruled-item retry expects a four-column grid. The five-column synthetic image reproduced a missing subtotal and tax, with its total recovered by the full-page fallback. The new reader isolates summary labels and amounts, including light text on a dark total band. Printed amounts retain separate source text and geometry. Arithmetic never fills a missing printed field in this retry. |
| Supplier and billed customer | `Issued to` was absent from the recipient aliases. Page segmentation can also read opposite columns between an address label and its value. Recipient extraction follows the printed column and can keep the contact and organization together when an aligned address follows. The issuer can be corroborated by a matching letterhead and payment recipient. A payment recipient alone still supplies uncertain evidence. |
| Dates and currency | Original date strings and both candidate interpretations remain available. When both same-format interpretations put the due date first, the review dialog shows that inconsistency before confirmation. An ambiguous dollar symbol still needs explicit currency confirmation. The synthetic image has unambiguous chronological dates. |
| Candidate selection | The new retry runs on invoices with missing printed summary fields, missing item rows or unresolved factor assignments. It requires labeled geometry and preserves the primary read's known header amounts and SKU-linked printed line amounts. The targeted read can replace exhaustive retries when it yields complete source-backed lines and totals. Quantity × price is never used to decide the order in the new path. |

The synthetic invoice reads five lines, including BBC-002 at quantity 5 and unit price 80. It retains invoice number `00456`, PO reference `PO-2030-082`, the two recipient names, and printed amounts $800, $80 at 10%, and $880. Its dollar symbol requires confirmation. [Summary before](synthetic-before.jpg) · [Summary after](synthetic-after.jpg) · [Line items after](synthetic-items-after.jpg)

## Remaining limitations

The targeted reader needs a detectable dark heading and a straight, ruled five-column table. Skew, damaged rules, missing headings, and difficult OCR still use the existing retries and review. A scanned PDF still uses the existing page and file limits. The Kraken runner measures parsing and Node OCR on the 181 original corpus inputs. The 48-file supplemental run and the synthetic regression exercise the browser-only cell-reading path. These reused datasets measure regression, and the original production images are still needed for acceptance.

**Readiness recommendation.** Keep Phase 0 open until the actual Morgan and Juliana files pass the production acceptance check.

## Image retests and processing times

| Browser input | Main | Candidate | Candidate result |
|---|---:|---:|---|
| Synthetic dark ruled table | 7.50 s | 7.22 s | Five lines, printed 800 subtotal, 80 tax, 880 total |
| Existing Morgan printed-tax fixture | 3.91 s | 3.23 s | Five lines, printed 900 subtotal, 90 tax, 990 total |
| Existing Morgan rate-only reconstruction | 5.96 s | 7.26 s | Five lines, 900 subtotal, printed tax unknown, 990 total |
| Existing Juliana reconstruction | 2.22 s | 2.78 s | Four lines, printed 870 subtotal, 87 tax, 957 total |

The times are single measurements on a shared runner with other test processes active. They include browser OCR worker initialization and do not isolate the cost of the retry. The focused fixture takes the cell-reading path instead of the broader first-pass fallback. The other tested images retain the original extraction path. [Full before-and-after extraction and timing](../../../benchmark/phase0-financial/production-ocr/image-retests.json)

## Regression results

| Measure | PR #23 baseline | Candidate |
|---|---:|---:|
| Kraken documents | 181 | 181 |
| Correct key fields | 1,297/1,576 | 1,297/1,576 |
| Exact line count | 147/179 | 147/179 |
| Fully correct line sets | 132/179 | 132/179 |
| Mean line F1 | 0.766 | 0.766 |
| Genuine and multi-invoice alerts | 7/7 | 7/7 |
| Kraken false alerts | 2/172 | 2/172 |
| Supplemental Chromium genuine alerts | 6/6 | 6/6 |
| Supplemental Chromium false alerts | 0/39 | 0/39 |
| Supplemental Chromium printed amounts | 90/90 | 90/90 |
| Supplemental Chromium quantity and rate | 84/90 each | 84/90 each |
| Frontend tests | 187 passed | 191 passed |
| Backend tests | 540 passed | 540 passed |

The Kraken corpus revision, answer key and scorer were unchanged. Per-document line F1 matched PR #23 throughout the corpus. The same three documents exceeded the five-page limit, and no OCR timed out. Chromium again caught the £3 subtotal gap in case 25 and produced no discrepancy alerts for the three split-tax controls. The 48-file Node run also caught 6/6 genuine differences and reported zero false alerts. It produced all six expected tax proposals and zero silent swaps. TypeScript, both structured benchmarks, and the reissued-reference regression passed. The first server run hit a setup-hook timeout under concurrent benchmark load. A full rerun with one worker and a 30-second hook limit passed all 540 tests.

Use `--production-ocr` with `benchmark/phase0-financial/unseen/browser.mjs` and `benchmark/phase0-financial/unseen/evaluate.mjs` to reproduce the new results without overwriting prior records. The Chromium runner also asserts the five labeled rows, amounts and currency confirmation on the committed synthetic fixture. Setup for the original dataset and Kraken scorer is in the [Phase 0 report](../README.md).

[Browser and Node results](../../../benchmark/phase0-financial/production-ocr/) · [Kraken document comparison](../../../benchmark/phase0-financial/production-ocr/kraken-documents.csv) · [Structured benchmark](../../../benchmark/results/v9/LATEST.md) · [Structured holdout](../../../benchmark/holdout/results/v9/LATEST.md)
