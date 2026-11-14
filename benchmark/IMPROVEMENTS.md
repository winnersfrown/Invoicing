# Reference and supplier fixes — validation record

Production rules were frozen in `holdout/engine-freeze.json` before the fresh fixtures were authored. They were not tuned after observing holdout outcomes. The same author created code and fixtures; this is not an independently blinded or representative customer trial. Inputs are structured JSON, not OCR results.

| Measure | Original frozen baseline | Revised rules on original set | Fresh 30-document set |
|---|---:|---:|---:|
| Duplicate recall | 4/6 | 6/6 | 5/6 |
| False duplicate alerts | 0/184 | 0/184 | 0/184 |
| Automatic PO classifications | 18/20 | 19/20 | 19/20 |
| Invoice issues detected/blocked | 8/8 | 8/8 | 7/7 |
| Automatic explanation checks | 18/20 | 19/20 | 19/20 |
| Clean comparisons requiring unnecessary block or identity review | 2/12 | 1/12 | 1/13 |
| Supplier typo cases completed after explicit human confirmation | Not available | 1/1 | 1/1 |
| Clear unsupported-credit explanation | 0/4 | 4/4 | 4/4 |

The remaining clean comparison deferral is deliberate: a similar spelling is not proof that two suppliers are the same legal entity. The UI requires a checkbox and a verification note, retains the original names, and carries the decision into JSON evidence. A new invoice/reference requires a fresh decision. Browser QA verified that submitting without confirmation is blocked and that confirmation enables comparison while payment stays NOT_APPROVED.

Supported copy/resend suffixes and OCR confusions require matching supplier, amount, and strong content similarity before being flagged for duplicate review. The holdout missed I06/I12 (`8600` versus `REISSUED-8600`). Ordinary repeat-purchase references remained distinct. Do not market this as universal altered-reference detection.

Credit-note processing remains unsupported; only the explanation and rejection boundary improved. Four credits in each set were rejected by the invoice validator, not reconciled. UI JSON import also gives an explicit unsupported-credit message. OCR and TXT credit classification require separate evaluation.

Reproduce: `npm test`, `npm run benchmark`, and `npm run benchmark:holdout`. The 21 unit tests passed. Repeated holdout runs produced identical result hashes. The original `results/baseline.json` and `results/REPORT.md` are unchanged. The holdout runner checks frozen production hashes and refuses changed engines; use a new evaluation version after future fixes.
