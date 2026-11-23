# Phase 0 final fixes

Branch `fix/phase0-final`, based on `main` at `2d54116` (after PR #17). Nothing is merged.

## What changed

### Task 1: invoice management (PR #12)

PR #12 was already merged into `main` before this work started, so there was nothing to merge or hold back. Its behaviour was checked on `main`:

- A supplier mismatch keeps the PO unlinked and records a `supplier_mismatch` finding; an uncertain supplier also holds the link until a reviewer confirms it.
- Unlinking keeps both documents. A database function checks the role, locks the invoice row, records the unlink and an audit event, and a trigger prevents the same PO from being re-linked.
- Archive and restore keep the invoice, its fields, findings, decisions and document. A trigger sets the author and time and writes the audit event.
- Roles, organisation isolation and audit entries are covered by `tests-server/services/invoice-management.test.ts` and, on this branch, `tests-server/api/isolation-phase0.test.ts`.

Gaps in `supabase/migrations/0003_invoice_management.sql`: it has no down migration, and `invoice_po_unlinks` is not protected against deletion by the privileged database connection (authenticated users cannot write it at all).

### Task 2: line-item matching

`main` already suggests matches for differently coded items and asks the reviewer to confirm them (PR #11, refined in #17). This branch adds:

- Each suggestion now carries its reasons: shared description words, same quantity, and a shared SKU number. The SKU number only supports other reasons; it never creates a suggestion on its own.
- A regression test for the LGO-001/LG-001, BAN-002/BN-002, PST-003/PS-003 example: three suggested pairs and no unmatched-line findings; after confirmation, a $5.00 unit difference and $10.00 on the banner line.

### Task 3: OCR table columns

- Rows are split by arithmetic (quantity × unit price = amount), so a price printed before the quantity no longer ends up in the description. This is the Morgan Maxwell failure: "Social Media Strategy Plan $100.00" with a blank amount and a wrong unit price.
- "Hours", "Hrs" and "Days" are quantity columns. An "Item" column beside a "Description" column holds the item code.
- A fourth number on a row is read as an amount in a second currency column; the line keeps the first currency.
- A row with a garbled number is kept with a blank amount, so totals become uncertain instead of contradicted. An ordinary first word is no longer taken as the SKU.
- OCR confusions are offered for confirmation instead of being kept or silently changed:
  - an item code read as `1GS-004` when the others start with letters;
  - a PO reference read as `P0-…`, which would otherwise stop the purchase order from linking.
- The supplier is read from a letterhead followed by a street address when OCR reads the right-hand "INVOICE" title late. It is marked uncertain.
- PR #17's fix for a price joined to the description inside a single OCR word is kept; the two fixes cover different cases.

### Task 4: decisions and feedback

- Recording a decision returns `next_step` (`correct_field`, `review_extraction`, `upload_po`, `await_supplier` or `none`) with a message. It is part of the contracts as `ResolveResponse`.
- The decision card shows the outcome, for example "Recommendation approved. Your decision has been saved. Waiting for the supplier to respond. Upload the corrected invoice when it arrives.", and the matching action buttons.
- An identical decision on a discrepancy that has not changed is refused, and Approve then reads "Already approved".
- The view refreshes after a decision. A decision never authorizes payment.

### Task 5: warnings and confirmation

- Warnings are presented as extraction errors, missing documents, review requirements or discrepancies. A missing PO shows "Upload the purchase order <reference>" with an upload button, not an OCR failure.
- An OCR quantity that reconciles only with a restored decimal point ("25" for "2.5") is uncertain and offered for confirmation, not a contradiction. Text PDFs with the same numbers still raise a contradiction.
- Uncertainty messages list each field with its source excerpt, page and confidence.
- Confirmation boxes in the review dialog name the field ("Line 4 item code"), space their buttons, and accept text for codes and references.
- Already covered on `main` and confirmed by tests: reviewer-confirmed currencies stay confirmed, unknown tax stays unknown rather than zero, ambiguous dates need confirmation, and a due date before the invoice date is warned about.

### Task 6: security

`tests-server/api/isolation-phase0.test.ts` (36 tests) uses two organisations and three roles each:

- viewers are refused on every mutating route;
- another organisation's record IDs return the same "not found" as missing records, on every route including archive, restore, unlink and resolve;
- audit rows exist for upload, resolution, field review, unlink, archive, restore and line-match review;
- the audit table is append-only, and a supplier-mismatched PO stays unlinked.

No row-level security or server authorization was changed. Not asserted: audit rows for investigation, supplier drafts and the status change on resolve, and isolation at the storage layer.

## Test report

| Check | Result |
|---|---|
| `npm test` | 171 pass, 0 fail, 2 skipped (Tesseract image tests; they run when `TESSERACT_CACHE` points at a folder with `eng.traineddata`) |
| `npx vitest run --no-file-parallelism` | 531 of 531 |
| `npx tsc --noEmit` | clean |
| `npm run benchmark` (v6) | unchanged from `main`: duplicates 6/6, 0/184 false; PO comparisons 18/20; issues 8/8; clean false alarms 1/12 |
| `npm run benchmark:holdout` (v6) | unchanged from `main`: 18/20; 7/7; 1/13 |

`benchmark/version.json` is now 6 with `benchmark/holdout/engine-freeze.v6.json`. Six engine files changed since v5: `arithmetic.js`, `document-metadata.js`, `extraction-review.js`, `layout-extraction.js`, `line-match-review.js`, `line-matching.js`. The freeze hashes LF bytes; on a Windows checkout with CRLF line endings `benchmark:holdout` refuses even on `main`, so it was run from an LF-normalised copy.

### Browser walk

Signed in as the seeded reviewer on the local dev server (`npm run dev`, scripted model, in-process database):

1. Uploaded the Morgan Maxwell image. Browser OCR read every field and line correctly; the dialog asked to confirm the `1GS-004` item code, and `IGS-004` was chosen.
2. The invoice showed "Purchase order needed" under missing documents.
3. Corrected the PO reference from `P0-2030-077` with "Correct field"; the invoice rechecked without a refresh.
4. Uploaded the PO from the prompt. It linked, all five lines matched on SKU, and the findings were a $10.00 unit-price mismatch and the $1.00 tax difference it causes.
5. Ran an AI investigation: evidence-cited findings, "Ask the supplier for a corrected invoice", and the $10.00 verified difference labelled as coming from deterministic validation.
6. Approved the recommendation: the notice above appeared, the status became "Awaiting supplier", and Approve became "Already approved".
7. Uploaded a corrected invoice: it validated, the original became "Superseded", and the original's decision note and audit trail were intact.

The test file was handed to the app's own upload button by a script, because the browser pane cannot open a native file picker. No screenshots are saved in the repository.

## Benchmarks

### DrewKraken regression (181 documents)

Scored with the benchmark's own scorer; answer keys unchanged. This set was used during development, so it is a regression check, not an unseen evaluation. Full tables: `benchmark/drewkraken/before.md` and `after.md`.

| Measure | `main` (2d54116) | This branch |
|---|---|---|
| Supplier | 155/181 | 155/181 |
| Invoice number | 135/179 | 135/179 |
| Invoice date | 149/179 | 149/179 |
| Due date | 105/140 | 105/140 |
| Currency | 153/179 | 153/179 |
| Subtotal / tax / total | 140 / 139 / 141 of 179 | 140 / 139 / 141 of 179 |
| Exact line-item count | 133/179 | 136/179 |
| Description and amount pairs | 740/1241 | 744/1241 |
| Documents with all lines right | 116/179 | 118/179 |
| Inconsistent files flagged (recall) | 7/7 | 7/7 |
| False alarms on consistent documents | 14/172 | 11/172 |
| Flag precision | 7/21 (33%) | 7/18 (39%) |
| Processing failures | 3 (PDFs over the 5-page limit) | 3 (same) |

Field by field, no document got worse; five scored fields improved, all on dual-currency invoices. Images were read with Tesseract in Node (`scripts/run-external-benchmark.mjs`), which lacks the browser's canvas retries, so image results understate the browser path. The benchmark has no purchase orders, so PO matching is measured below and in the structured benchmark.

### Phase 0 holdout

`benchmark/phase0-holdout/` holds six invoice images and five matching cases written after the code was otherwise final (`node scripts/make-ocr-fixtures.mjs --holdout`, `node benchmark/phase0-holdout/run.mjs`). Results: `results.json` (this branch) and `results-main.json`.

| Measure | `main` | This branch |
|---|---|---|
| Supplier | 0/6 | 4/6 |
| Invoice number, subtotal, tax, total | 6/6 each | 6/6 each |
| Description and amount pairs | 14/22 | 17/22 |
| Amounts left in descriptions | 0 | 0 |
| Invoices with a false contradiction | 0 | 0 |
| Matching: expected pairs suggested or exact | 5/5 | 5/5 |
| Matching: wrong suggestions | 0 | 0 |
| Matching: verified difference right | 5/5 | 5/5 |

One holdout result informed a change. The first run showed a false contradiction on `cedar-lane`, where OCR read "2.5" hours as "25". That led to the dropped-decimal rule above. After it, that invoice has no contradiction, so `cedar-lane` is no longer unseen for that rule.

## Known limitations

- Rows that print the quantity first ("1 Monthly bookkeeping $450.00 $450.00") are not read (`quill-ledger`: 0 of 4 lines).
- A wrapped description line that contains digits ("(set of 100)") is not joined to its line.
- Supplier letterheads without a street address or contact line are still missed (2 of 6 holdout invoices).
- OCR suspicion covers a single changed digit, a moved decimal in an amount, and a dropped decimal in a quantity. Other misreads in text that OCR reads confidently are still treated as printed.
- "Review extraction" opens the original document rather than a field review screen.
- On a superseded invoice, open findings keep their last status; they are history, not live work.
- Line-matching reasons and supplier letterhead detection are heuristics, not calibrated probabilities.
- No real Supabase, OpenAI or Vercel environment was used. Concurrency is tested only on PGlite.
