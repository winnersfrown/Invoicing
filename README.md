# Accounting — invoice automation demo

A browser-local accounts payable demo for the Diamond Challenge project.

## Try the demo

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

Verified with automated workflow tests and a browser walkthrough of batch processing, approval and correction of a mismatched total.
