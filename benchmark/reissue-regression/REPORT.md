# Reissued-reference regression

The previously missed pair was `8600` / `REISSUED-8600`. The rule now recognizes standalone delivery labels (reissue, reissued, resend, resent, copy, duplicate) at reference edges. It still requires the normalized supplier, total and strong text similarity to agree. Original references are retained and suspected duplicates require a human decision.

| Existing dataset | Duplicate recall | False duplicate alerts |
|---|---:|---:|
| benchmark | 6/6 | 0/184 |
| benchmark/holdout | 6/6 | 0/184 |

These datasets are now regression fixtures, not unseen validation. Prior baseline and holdout reports remain unchanged. The original frozen holdout command intentionally refuses changed engine hashes; run `npm run benchmark:reissue` for this version instead. Every pair decision and engine/input hashes are saved in results.json.

35 unit tests pass, including six delivery-label variants, six unrelated references, insufficient evidence, and human override. No automatic deletion or payment approval was added. Arbitrary reference rewrites and heavily degraded OCR remain outside this narrow fix.
