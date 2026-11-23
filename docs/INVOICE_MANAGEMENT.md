# Invoice management

Reviewers can archive and restore invoices, unlink a purchase order, and open archived records and their history. The archive list is available below the active inbox. Archive and restore keep the invoice's original file, extraction, findings, and reviewer decisions. Restoring an invoice rechecks active matching and duplicate rules.

Sorikano requires a matching PO reference and a verified supplier name before automatic linking. Conflicting or uncertain suppliers stay unlinked until a reviewer verifies and corrects the invoice fields. An unlink records who removed the link and blocks the exact pair, including after archive and restore. The purchase order stays available to other eligible invoices. Existing active links are checked under these rules the next time the invoice is processed.

Apply `supabase/migrations/0003_invoice_management.sql` before deploying the application changes. It adds archive metadata, the unlink records, and audit triggers. Existing invoices start active. The migration leaves existing documents and audit records in place.

## Permanent deletion follow-up

Invoice deletion needs a retention and hold model before an administrator can safely purge a record. First establish the organization's retention rules, legal and compliance holds, active workflow holds, and what deletion evidence may be retained. Then design an administrator-only purge to recheck eligibility at execution, clean up restricted dependent records and private storage with retry support, preserve the permitted minimal audit event, and leave purchase orders intact. Existing immutable audit and resolution records and restrictive foreign keys need explicit handling. This release ships archive and restore.
