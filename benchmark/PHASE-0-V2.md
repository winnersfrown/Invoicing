# Sorikano Phase 0 regression

## Structured invoice benchmark

Version 2 uses the two previously evaluated 30-document datasets. The runner retains their original fixture bytes and expected labels. The v2 hash manifest records the engine used for these runs.

| Metric | Original fixtures | Historical holdout |
| --- | ---: | ---: |
| Duplicate pairs detected | 6/6 | 6/6 |
| False duplicate alerts | 0/184 | 0/184 |
| Exact PO comparison classifications | 18/20 | 18/20 |
| Explanation checks passed | 18/20 | 18/20 |
| Clean PO comparisons deferred to supplier review | 1/12 | 1/13 |

In each set, the other classification difference was an incorrect stated total. The historical label requires rejecting the document as invalid. The current engine reports an arithmetic discrepancy so it can be reviewed. The original labels remain in the fixtures.

Run `npm run benchmark`, `npm run benchmark:holdout`, and `npm run benchmark:reissue` from the repository root. The first two commands write under the corresponding `results/v2/` directory.

## Browser extraction benchmark

Chromium ran `extractFile` and `parseExtractedText` with PDF.js 4.10.38, Tesseract.js 5.1.1, and locally served English OCR data. The parser received extracted layout coordinates. The fixture set was the 121 previously tested documents outside the original 60 in the 181-document v1 corpus. The table scores the 108 single invoices. The other 13 files included credit notes, statements, and a combined invoice file. Field comparisons ignore case and punctuation, allow one cent for amounts, and score line pairs one-to-one.

| Metric | Correct | Rate |
| --- | ---: | ---: |
| Supplier | 94/108 | 87.0% |
| Invoice number | 82/107 | 76.6% |
| Invoice date | 87/108 | 80.6% |
| Currency | 89/108 | 82.4% |
| Subtotal | 86/108 | 79.6% |
| Tax | 78/108 | 72.2% |
| Invoice total | 87/108 | 80.6% |
| Exact line-item count | 80/108 | 74.1% |
| Description and amount pairs | 317/784 | 40.4% |

The browser produced text and layout for 116 of the 121 files. Three PDFs hit the app's five-page limit. One severe rotated photo returned no readable text. One low-light photo hit the harness's 90-second timeout. All five are included in the applicable denominators. Handwriting yielded the correct item count on 4 of 4 files and one correct description/amount pair out of 13.

## Extraction review smoke test

In the local browser demo, the sample PDF loaded the vendor, invoice number, PO reference, USD, two line items, and a 660.00 total. Source evidence opened and the reviewed file appeared in the inbox. The PNG sample required a vendor spelling correction and manual PO reference entry. The corrected image also appeared in the inbox. These browser checks exercise the local review UI. The server upload and validation checks run separately against the API with an isolated test database.
