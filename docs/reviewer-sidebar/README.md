# Reviewer sidebar verification

The sidebar opens on Invoice Inbox after sign-in. An existing signed-in session restores its selected section after a refresh. The four-step tutorial opens the seeded sample invoice and finding. Advancing the tutorial does not create or change workspace records.

| Section | Browser verification |
| --- | --- |
| [Invoice Inbox](invoice-inbox.jpg) | The public landing page led to signup and the private Reviewer inbox. Invoice upload, OCR field review, corrected upload, archiving and restoration worked. |
| [Purchase Orders](purchase-orders.jpg) | The order list accepted an upload. Order detail showed line items and opened an associated invoice. |
| [Discrepancy Review](discrepancy-review.jpg) | The $60 finding opened the correct invoice. Investigation evidence, approval, rejection, next-step feedback, correction drafts, duplicate evidence and suggested line-match confirmation worked. |
| [Activity History](activity-history.jpg) | Reviewer notes and audit events persisted across refresh and sign-out/sign-in. An invoice activity item opened its invoice-specific history. |
| [Tutorial](tutorial.jpg) | All four steps ran against the original seeded invoice, PO and finding. Completing the guide left invoice and order counts unchanged. |
| [Mobile sidebar](mobile-sidebar.jpg) | All five links worked at 390 pixels, with the selected section highlighted and no page-wide horizontal overflow. On desktop, Tab and Enter activated a sidebar button and moved focus to the new page heading. |

A second Reviewer provisioned a separate workspace. Cross-workspace invoice and purchase-order requests returned 404, and the second workspace's activity contained none of the first Reviewer's decision notes.

| Check | Result |
| --- | --- |
| `TESSERACT_CACHE=<English trained-data directory> npm test` | 174 passed, including both OCR image fixtures |
| `npm run test:server` | 538 passed |
| `npm run typecheck` | Passed |
| `git diff --check` | Passed |

The screenshots and browser run used a local copy of the public landing page, synthetic email confirmation, the real router and database migrations, and the scripted investigation model. Hosted email delivery and live AI were outside the run. The purchase-order detail finds associated invoices within the existing list endpoints’ limits of 200 active and 200 archived records. For older records, existing invoice-specific history remains available when the invoice is found. Activity History reuses the paginated endpoint already on main.
