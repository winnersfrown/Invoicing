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

The matching inputs accept structured `.json` documents under 500 KB with the schema illustrated in `dist/samples/matching-invoice.json` and `matching-po.json`. PDF text extraction and English OCR for images/scanned PDFs are connected in Match invoice & PO. Upload PDF, PNG, JPEG or WebP (15 MB; PDFs up to 5 pages). Verify extracted fields and line items in the review dialog. Field detection uses simple patterns and does not reliably interpret every vendor layout; missing rows can be added manually. Currency defaults to USD and must be verified. PDF.js 4.10.38 and Tesseract.js 5.1.1 load pinned browser code from jsDelivr; OCR also loads English language data. Internet access is needed for these assets, but document bytes remain in the browser. No API key is needed. Real email sending and accounting integrations remain disconnected.

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

The separate legacy inbox still accepts labeled text only. Email monitoring, bank payments, accounting integration, server database and multi-user approval routing are not connected. Records persist only in this browser's localStorage; the log is illustrative, not an immutable audit trail. All sample businesses and documents are fictional. This is a demonstration, not production accounting software.

## Structure

- `dist/index.html`, `dist/style.css`, `dist/app.js`: interface and local workflow
- `dist/engine.js`: validation, approval, import and export logic
- `dist/samples.js`, `dist/samples/`: seeded data and downloadable source documents
- `tests/workflow.test.js`: validation, workflow and export tests
- `.openai/hosting.json`: private demo deployment configuration

Verified with automated workflow and matching tests, plus browser checks of comparison evidence, correction drafting, review gating and CSV download.

## Opportunities A and B

### A — duplicate review

Open **Duplicate review** to scan every non-rejected queued or completed invoice/receipt, import a batch (up to 20 files), or add four resilience examples. Signals include SHA-256 file identity, supplier suffix/punctuation normalization, invoice-reference prefix normalization, and extracted-text word overlap. Same supplier and amount alone do not flag a pair; conflicting nonempty references are conservatively preserved unless stronger evidence applies. Similarity is a heuristic, not a calibrated probability or image-layout comparison.

Both sides of unresolved candidate pairs are blocked from inbox approval. Review source evidence, choose which record to retain, and give a reason. Confirming a duplicate rejects the other record without deleting its source. Marking distinct records the decision against the evidence; edits invalidate that decision. New imports and rescans revisit completed records too. This is a single-browser queue, not a server-concurrent transaction system. The processing sequence prevents a local batch from bypassing checks; multi-user concurrency will need server-side enforcement.

### B — discrepancy resolution

After comparison, select **Track correction & resolution**. The local case preserves the original invoice, PO and comparison; provides an editable correction draft; records manually logged supplier communications; accepts a revised invoice via JSON/PDF/image; and verifies the revision against the original PO. A changed invoice number is allowed when the vendor and PO agree; the reviewer must confirm that it replaces the original.

A revision that still differs stays on hold. A matching revision requires a reviewer checkbox and verification note before resolving the discrepancy. Resolution never approves payment. Export the case JSON for original documents, all revisions, comparison evidence, notes, timestamps and explicit payment status. One case is retained in browser storage; export before replacing it. This local history is not an immutable audit log. No supplier messages are sent automatically. Opportunity C is outside this release.

## Controlled synthetic benchmark

Run `npm run benchmark` from the repository root (Node 18+; no network needed).
The dataset contains exactly 30 synthetic documents: 20 invoices, 6 POs and 4 credit notes, each with JSON and readable TXT representations. `benchmark/ground-truth.json` holds predefined expected results; `benchmark/generate.mjs` regenerates the fixtures deterministically.

The frozen initial results are in [benchmark/results/REPORT.md](benchmark/results/REPORT.md) and `benchmark/results/baseline.json`. Subsequent runs write `LATEST.md` and `latest.json`; preserve the initial baseline. All pair decisions, raw comparison outputs, drafts and SHA-256 input/engine hashes are included. A successful runner exit means measurement completed, not perfect product accuracy.

This benchmark tests structured detection and explanation facts. It does not measure PDF/image OCR or live upload concurrency. Credit notes currently receive an unsupported-type rejection; credit reconciliation is not implemented. TXT files are human-readable evidence, not inbox-import fixtures.

### Reference and supplier improvements

Supported copy/resend suffixes and common O/0 or I/L/1 OCR confusions now trigger duplicate review only with matching normalized supplier, total, and at least 90% token overlap. Ordinary sequential references remain distinct. This is a conservative heuristic; not every altered reference is caught.

PO matching normalizes company suffixes and punctuation. One-character supplier spelling differences require explicit identity confirmation and a note in the UI before comparison can proceed; the decision is scoped to the supplier names and document references and exported with the evidence. Credit-note JSON receives a clear unsupported message; credit processing is still not implemented.

Run `npm run benchmark:holdout` for the new 30-document evaluation. Production JavaScript hashes were frozen before generating it; the runner refuses changed engine hashes. Its author also wrote the implementation, so it is fresh synthetic validation rather than an independently blinded test. Results are in `benchmark/holdout/results/LATEST.md`. The original frozen baseline is unchanged.

### Reissued-reference regression

The previously missed `REISSUED-8600` / `8600` pair is now detected for human review. Standalone reissue/resent/copy labels can appear at either reference edge; matching supplier, amount and strong content evidence are still required. Arbitrary reference changes are not universally detected.

Run `npm run benchmark:reissue`. Results on both previously seen datasets are in [benchmark/reissue-regression/REPORT.md](benchmark/reissue-regression/REPORT.md). The old holdout remains frozen and its original command intentionally rejects changed engine hashes. This rerun is regression testing, not fresh holdout validation.

## Connected inbox workflow

The inbox is now the starting screen. Select **Load complete $60 example**, then **Process all invoices**. On invoice NS-1068 choose **Match purchase order**; its invoice and sample PO are already loaded. Compare, select **Track correction & resolution**, prepare the draft, load or upload a corrected invoice, and explicitly resolve it. **Back to invoice inbox** shows the resolved status and $600 corrected amount alongside the $660 original. Review and approve for export separately; CSV uses the verified replacement reference and amount. No payment or message is sent.

Inbox import now accepts JSON, PDFs, images and labeled TXT. Structured invoice line items are retained. TXT and older inbox records require a one-time line-item review using their existing source text; no re-upload is needed. New imported invoices require PO matching before export. Legacy demo records keep their original non-PO validation flow until a PO workflow is started.

Cases are stored per inbox record and survive refreshes. Switching invoices preserves each linked case. Editing source fields invalidates prior matching and archives previous workflow evidence. Unresolved or stale comparisons cannot be approved or exported; corrected invoices are rechecked for duplicates. Approved case evidence is read-only and remains exportable. Data remains in this browser; these are not multi-user server records or tamper-proof audit logs.

Validation: 40 unit tests cover holds, resolution, corrected exports, stale source changes, case isolation and replacement duplicates. Browser QA completed the $60 flow, refresh/resume, approval, read-only case access and CSV download.

## Layout and evidence improvements (2026-11-15)

PDF.js and Tesseract remain the local text/OCR pipeline. The new layout parser groups PDF tokens by page/position, uses table headers and column positions, recognizes common labels, and preserves displayed line amounts, subtotal, tax rate, tax, invoice date and total independently. The original regex parser is available as `parseBaselineText`; the extraction dialog shows its output for comparison. Pattern-only rows and weak OCR evidence are marked uncertain. Missing values are not silently converted to zero or an assumed currency.

The review dialog provides per-field support labels and source snippets with page/row metadata. These labels are heuristic evidence descriptions, **not calibrated probabilities**. Original extraction values and the review snapshot are retained. Reviewers must confirm the document; confirmation never initiates payment. Optional printed amounts can remain unknown when absent from the source.

`arithmeticChecks` compares quantities/prices, printed line amounts, subtotal, tax rate and totals in cents. Numerical contradictions are retained as evidence, shown in matching, included in drafts and JSON exports, and block invoice approval/case resolution. Structural errors (unsupported currency/type, malformed values, missing required matching fields) still require correction. Tax-rate checking assumes one explicitly stated document-wide rate on the displayed subtotal; multiple tax bases, discounts, freight and complex tax treatments are not modeled and need review.

Duplicate evidence now includes issue dates (not due dates), canonical line signatures, optional supplier identifiers, currency and file fingerprints alongside normalized names/references and text similarity. Different ordinary references remain distinct even when amount and line items agree. Date differences suppress weaker missing-reference/reissue candidates; explicit currency/identifier conflicts suppress field-only candidates. Exact file matches still surface for review. Changing these inputs invalidates prior duplicate decisions. Nothing is deleted automatically.

Validation: `npm test` includes extraction/coordinate fixtures, an actual sample-PDF extraction, arithmetic holds, review/export guards, OCR-box fixtures and conservative recurring-invoice cases. Browser QA verified PDF upload, field evidence, contradiction retention, PO comparison and draft text. This is development regression testing, not a blinded OCR accuracy benchmark. Existing baseline and holdout results remain unchanged; their historical `invalid_total` classification predates the new investigable-arithmetic-discrepancy behavior. Do not compare those labels directly without a versioned evaluation protocol.

## Hybrid workspace: no OpenAI costs

Run `npm ci`, then `npm run dev`. Open the printed local URL, choose **Sign in**, and select **Dev reviewer**. The shared demo is seeded with a $540 invoice and $480 PO. Open its discrepancy, investigate it, inspect the $60 engine evidence, draft a correction request, and record a reviewer decision. The investigator is scripted; it does not call OpenAI. The local database and files reset when this process stops. Dev identities are local test accounts and are never served by the production API.

Both the local server and Vercel API now default to `AGENT_MODE=scripted`, even if `OPENAI_API_KEY` is already configured. Paid calls require explicit `AGENT_MODE=openai`; keep that disabled for this phase. `.env.example` lists server-only production settings. Scripted mode eliminates OpenAI model charges, but hosting/database providers may have their own costs. A hosted shared workspace still requires Supabase migrations, organization membership provisioning, private storage, and the documented environment variables. GitHub Pages serves the browser-local demo only.

The Vercel rewrite routes `/api/*` to the single function; the daily cron sweeps jobs missed by immediate background execution. Do not deploy the dev server or its fake users publicly. Configure `CRON_SECRET` for the production job endpoint. The verifier checks cited IDs, supported numeric amounts, and common price-direction contradictions; it does not establish general natural-language entailment. Human review remains required. AI output cannot recommend closing an open discrepancy directly.

### Open signup for the hosted demo

In Supabase Auth, enable signups and email confirmation. Configure [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) so confirmation links reach testers outside your Supabase team. Set the [Site URL and allowed redirect URL](https://supabase.com/docs/guides/auth/redirect-urls) to the hosted Sorikano URL (`https://invoicing-fawn.vercel.app/` for this deployment).

Set `PUBLIC_SIGNUP=true` in the Vercel Production environment and redeploy. A tester can choose **Sign up**, confirm their email, and open their own workspace. Sorikano seeds it with invoice NS-1068 ($660) and purchase order PO-2026-042 ($600). Their account has reviewer access. Existing accounts with a workspace continue using their existing membership. Before sharing the signup link, confirm that an email address outside the Supabase team can receive a link and see the sample.

## PDF feedback and guided retest

The tester LorenzinAsia reported missing-label messages on a historical company invoice and requested a simpler first-use flow. Their original PDF has not been supplied, so this change does not claim an exact reproduction or confirmed user retest. PDF parsing now covers compact labels, stacked label/value rows, explicit currency totals, and a conservative company-heading suggestion marked uncertain. Missing PO references, dates and SKUs can be retained at intake for later review; malformed numeric values are rejected and completeness still gates matching/approval.

First use shows one invoice-upload action and a $60 example. After intake, the inbox focuses on the uploaded reference and the rest of the workspace becomes available. “Explore all features” skips the guide; “Guided start” replays it without deleting invoices.

Retest protocol for the same tester: open the deployed demo, choose Guided start, upload the same redacted PDF, inspect supplier/reference/date/subtotal/tax/total and every line against the source, continue without inventing absent values, then process and review the imported invoice. Record missing/wrong fields, exact error messages, time to first successful import and where help was needed. Confirm that the guide gave a clear next step and that incomplete invoices cannot be approved. Obtain the tester's results before claiming this feedback resolved. No outreach has been sent automatically.
