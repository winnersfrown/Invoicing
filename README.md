# Invoicing — invoice automation demo

A browser-local accounts payable demo for the Diamond Challenge project.

## Featured demo: invoice vs. purchase order

The default **Match invoice & PO** page demonstrates the complete discrepancy workflow:

1. Download the sample invoice and purchase order JSON files, then upload them into their labeled inputs; or click **Load $60 example**.
2. Click **Compare documents**. Invoice NS-1068 totals $660; PO-2026-042 totals $600.
3. Inspect the highlighted source lines: 12 paper cases cost $45 each on the invoice versus $40 each on the PO. The application calculates 12 × $5 = $60; the result is not hardcoded.
4. Click **Draft correction request**. Edit the message and download it as text. No email is sent.
5. Confirm that you reviewed the evidence, then export CSV or JSON. JSON includes per-line evidence. Both formats explicitly retain `paymentApproved: false` and `ON_HOLD` for discrepancies. Reviewing does not mark the invoice corrected or authorize payment.

Comparison validates document type, vendor, PO reference, USD currency, unique SKUs, positive whole-number quantities, prices and document arithmetic. Changed or missing items and tax differences stay visible even if opposing differences net to zero. Replacing either source invalidates its previous review and draft. These matching-session documents and drafts stay in memory until reload; use export to keep the reviewed data. The existing inbox continues to use browser-local persistence.

The matching inputs accept structured `.json` documents under 500 KB with the schema illustrated in `dist/samples/matching-invoice.json` and `matching-po.json`. Arbitrary PDFs/images, OCR, real email sending and accounting integrations are not included in this demo.

## Try the invoice inbox

1. Open the app and select **Process all invoices**.
2. Review the two clean invoices and approve them.
3. Reject the resent Northstar invoice as a duplicate.
4. Correct Harbor's total to **918.00**, save/recheck, and approve.
5. Enter Cloudline's missing due date (**2026-12-12**, per the exercise), confirm the details, save/recheck, and approve.
6. Export approved invoices as CSV. Reset demo restores all five originals.

The Sample documents page provides all five fictional originals as downloadable `.txt` files. Import accepts labeled UTF-8 `.txt` invoices under 500 KB using the sample format. Download and reimport a sample to test duplicate detection.

## Run locally

Serve `dist/` using any static web server, for example `python3 -m http.server 8000 --directory dist`, then open http://localhost:8000. Node 18+ runs checks with `npm test`; there are no package dependencies or build step.

## Scope

Sample extraction is simulated from seeded fields. Text imports use a deterministic labeled-text parser. Validation, field correction, duplicate checks, approval/rejection, CSV export, browser persistence and activity history work locally. Duplicate detection compares normalized vendor + invoice number against earlier non-rejected documents. CSV contains approved records only and guards against spreadsheet formula injection.

No OCR, PDF/image ingestion, email monitoring, bank payments, accounting integration, server database or multi-user approval routing is connected. Records persist only in this browser's localStorage; the log is illustrative, not an immutable audit trail. All sample businesses and documents are fictional. This is a demonstration, not production accounting software.

## Structure

- `dist/index.html`, `dist/style.css`, `dist/app.js`: interface and local workflow
- `dist/engine.js`: validation, approval, import and export logic
- `dist/samples.js`, `dist/samples/`: seeded data and downloadable source documents
- `tests/workflow.test.js`: validation, workflow and export tests
- `.openai/hosting.json`: private demo deployment configuration

Verified with automated workflow and matching tests, plus browser checks of comparison evidence, correction drafting, review gating and CSV download.
