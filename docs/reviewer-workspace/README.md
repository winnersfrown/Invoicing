# Reviewer workspace verification

All screenshots show synthetic documents and a synthetic Reviewer in a local Chromium session. Browser verification used the real application router, database migrations, workspace provisioning, and OCR engine. The harness supplied the verified email callback and used the scripted investigation model. Hosted email delivery and a live model endpoint were outside this run.

| Section | Verified in Chromium |
| --- | --- |
| [Invoice Inbox](invoice-inbox.jpg) | A newly provisioned Reviewer received the sample invoice. Invoice uploads, corrected uploads, archive and restore worked. |
| [Purchase Orders](purchase-orders.jpg) | The seeded order loaded with line details. A second order uploaded and appeared in the same private workspace. |
| [Duplicate Review](duplicate-review.jpg) | A second delivery of an invoice raised a duplicate finding with evidence and a link to the suspected invoice. |
| [Invoice & PO Matching](invoice-matching.jpg) | The sample documents showed the $60 difference. A separate fixture allowed the Reviewer to confirm a suggested line match and save a field review. PO unlinking was verified. |
| [Discrepancy Resolution](discrepancy-queue.jpg) | The $60 finding opened directly from the queue. The Reviewer [ran the investigation and inspected its evidence](investigation.jpg), rejected and approved the recommendation, then [downloaded the correction draft](decision-and-draft.jpg). |
| [Sample Documents & Tutorial](sample-tutorial.jpg) | The guide opened the seeded invoice and downloaded the sample. [Image OCR](ocr-review.jpg) extracted the sample and the Reviewer corrected its PO reference before uploading. |
| [Activity History](activity-history.jpg) | Reviewer notes and document changes appeared. Documents and decisions survived reload and sign-out/sign-in. |

The signed-out page hid the workspace navigation. A second Reviewer provisioned a separate sample workspace. Requests for the first Reviewer's invoice and purchase order returned 404, and the second workspace's activity contained none of the first Reviewer's decision notes. Server regression tests also cover private file signing, cross-organization mutations, forbidden access, audit immutability and pagination.

| Check | Result |
| --- | --- |
| `TESSERACT_CACHE=<English trained-data directory> npm test` | 174 passed, including both OCR image fixtures |
| `npm run test:server` | 538 passed |
| `npm run typecheck` | Passed |
| `git diff --check` | Passed |
