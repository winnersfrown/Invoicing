# Phase 0 backend authorization

Base revision ff01e6c includes PR #24. Hold confidential customer uploads until production cutover and acceptance.

## Root cause and trust boundaries

The browser uses Supabase Auth for signup, confirmation and sessions. Its financial screens call Sorikano's API. The previous API entered the same PostgreSQL role as a signed-in Data API client. RLS correctly scoped records to a workspace, but the grants also allowed an in-workspace client to write financial data without using Sorikano's validation, human decision or audit services. Append-only triggers protected old rows while leaving insertion available. The production catalog confirmed the grants. This inspection found no evidence about whether anyone used them.

After cutover, the browser has no application table privileges. The API validates the bearer with Auth, requires a confirmed email, excludes anonymous users, derives membership from the returned user ID and requires Reviewer. Financial handlers enter a transaction-local NOLOGIN, NOBYPASSRLS role with the verified caller's subject. They use parameterized organization predicates plus existing RLS policies. Line visibility follows the parent. Migration 0004 constrains every membership to Reviewer. The workflow role owns no application tables and receives no membership-management access. Production credentials belong only in server secrets.

### Permission inventory

| Resource | Previous authenticated table grants | Request role after cutover |
|---|---|---|
| Organizations / memberships | Read and update / read, insert, update, delete | Read organization name / none |
| Suppliers | Read, insert, update, delete | Read and insert |
| Invoices / discrepancies | Read, insert, update | Read, insert and update designated workflow columns |
| PO headers and both sets of lines | Read, insert, update | Read and insert |
| Investigations | Read, insert, update | Read and enqueue a request bound to the caller. Only the existing worker completes it |
| Decisions / supplier drafts / audit | Read and insert | Read and insert. RLS binds authors to the session. The database supplies audit timestamps |
| Tool calls | Read and insert | Read. The worker writes calls |
| Invoice–PO unlink records | Read | Read. A private, role-restricted function performs and audits an unlink |
| Jobs / idempotency | None | None. Existing server coordination handles both |
| Private invoice bucket | Organization-scoped reads and inserts | Server storage client only. The API validates organization, invoice ID and file hash before signing |

No financial screen requires direct Data API or Storage grants. Requests derive actors internally. The router commits state changes, decisions, audit rows and idempotency records together. A successful agent tool invocation commits its effects and its call record together. AI completion records and their audit event also commit together. The existing privileged connection still handles membership lookup, provisioning, background work and idempotency. Its credentials and the Storage service key are high-value secrets. The limited role protects request handlers; it does not contain compromise of the parent connection.

Invoice management history now also shows the recorded creation of a correction and the recorded transition of its original to superseded, with their IDs, actor and time. Historical events are read as stored. No backfill is required. Superseded findings remain readable and closed to new decisions, investigations and correction drafts.

## Verification matrix

| Check | Authorized result | Denied or failure result | Environment |
|---|---|---|---|
| Registration / returning workspace | Concurrent provisioning creates one workspace and sample per identity, returning account retains prior decisions | Missing, anonymous, invalid, expired and unconfirmed sessions fail the appropriate verifier or route | Real router and PostgreSQL policies, controlled Auth responses |
| Financial records and history | Two synthetic Reviewers can see their own invoice, PO, lines, supplier, findings, decisions, draft, investigation, tools and audit | Foreign identifiers are invisible in SQL. API foreign resources receive the same response as missing resources | Disposable PostgreSQL via PGlite |
| Approval, audit and mutations | Reviewer workflow derives actor from verified session. Northstar approval ignores an extra actor field | Direct authenticated financial statements denied. Audit failure rolls back the financial mutation | Disposable PostgreSQL |
| Reviewer-only migration | Sole-member conversions are recorded. Existing records survive | A shared legacy workspace aborts 0004. Invalid new roles hit the constraint | Disposable PostgreSQL |
| Original files and management | Authorized canonical path gets a short-lived URL. Both originals survive replacement | Foreign invoice returns 404. A substituted path receives no URL. No browser bucket policies remain | PGlite Storage policy schema and in-memory object service |
| Financial lifecycle | Upload, field review, matching, duplicate detection, investigation, approval/rejection, drafts, correction, archive, restore, unlink and history | Closed or conflicting changes are refused | Router, scripted model, synthetic data |

Northstar NS-1068 at $660 matched PO-2026-042 at $600. The $60 finding produced a scripted investigation and a human decision requesting correction. The unsent draft was generated. The replacement validated at $600, the original retained $660, and both versions retained document objects and linked history.

The original-image Chromium extraction and review checks passed. Juliana retained four items and $870 + $87 = $957 in 9.1 seconds. Morgan retained five items and $900 + $90 = $990 in 10.7 seconds. The review retained the SKU, date and currency confirmations. These timings measure extraction on this machine.

Structured benchmark v11 freezes the updated UI file and preserves v10. All pair decisions, PO comparisons, credit checks and input/answer hashes matched v10 for both sets. Each found 6/6 duplicate pairs with zero false alerts in 184 negative pairs. PO classifications were 18/20 on each set. Baseline found 8/8 issues with one clean false alarm in 12. Holdout found 7/7 with one in 13.

## Advisor and production preflight

Read-only production metadata on November 26, 2026 showed four Reviewer memberships across four organizations, zero shared workspaces, zero legacy memberships, sixteen RLS-enabled tables, a private invoice bucket, and no Reviewer-only check constraint. Only the expected select and insert policies existed on Storage objects. The production Security Advisor reported the authenticated current_role_in warning, disabled leaked-password protection, and informational notices for jobs and idempotency_keys.

On the disposable migrated schema the upstream Supabase Splinter SQL at cc529aa reported zero security warnings or errors and the two informational notices. Those two tables intentionally have no user policies. The SQL advisor cannot evaluate hosted Auth settings. [Database linter](https://supabase.com/docs/guides/database/database-linter) · [Password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)

## Approval and release procedure

1. Before rollout, repeat aggregate membership and RLS/grant checks, confirm the storage bucket and all applicable object policies, identify the actual server pooler login, and check for any other consumers of the direct grants. Verify email confirmation, existing Auth rate limits and eligible leaked-password protection in the project dashboard. Change the latter only with approval. Keep SMTP separate.
2. Capture a restorable database backup/PITR point and schema, role memberships, ACLs and policies. Verify a restore in isolation. Back up private object bytes separately with their paths and hashes. A database backup includes Storage metadata only. Record the application deployment revision and aggregate row counts. Protect all backups as confidential.
3. With approval, apply 0004 then 0005, each transactionally. Stop at 0005. Do not batch all pending migrations into one push. The old deployment continues using authenticated until the switch. 0005 grants the workflow role to the migration login. If the runtime login differs, the DBA must explicitly authorize only the trusted login to SET ROLE. Verify this through the actual pooler. Verify that browser, authenticator and public gateway roles cannot assume the new role.
4. After approval deploy the matching application. Exercise one synthetic workspace through the real API, storage and background worker. Confirm that all serving instances and scheduled workers run compatible code before applying 0006. The old browser grants remain a known exposure throughout this compatibility window. Keep external confidential uploads on hold.
5. Apply 0006 transactionally. Recheck effective table/column grants, function EXECUTE, role membership, private-bucket policies, audit triggers, and RLS. Run hosted Security Advisor. Confirm that the helper warning clears. A separate approval covers enabling leaked-password protection if available on the project plan.
6. With two controlled, verified mailboxes, repeat the Northstar flow on the approved deployment. Check new signup, confirmation recovery, sign-in, return visit, activity and inaccessible foreign IDs using only the synthetic accounts. Verify a signed URL works immediately, expires after 300 seconds and becomes available again only after authorization. Avoid recording tokens, signed URLs or document bodies. Verify original and corrected objects still download for the owning account.
7. Stop on a missing audit event, changed historical amount, visible foreign record, broken signup, unexpected grant, or blocked legitimate workflow. Before 0006, revert the application to the recorded revision if needed, leaving additive 0005 in place. After 0006, keep the hardened grants and roll forward with a role-compatible application or return to the last role-compatible deployment. If none works, temporarily suspend financial mutations. Reinstating the original grants reopens the known bypass and requires a separately approved emergency plan. Restore the pre-change backup into an isolated instance to reconcile data before any production restore. Never discard later legitimate decisions as a routine rollback.

## Open release risks

The production tests in this change read metadata only. Live end-to-end confirmation mail, pooler grants, object expiry, Auth rate limits and the post-cutover advisor require an approved environment with the candidate deployed. Disabled leaked-password protection remains open. Original object upload and PostgreSQL commit use separate services: a late database rollback can leave a private, unreferenced object. Signed links already issued can be used until expiry. Future application tables and functions need explicit grants in their migrations because hosting defaults can grant access. Keep Phase 0 closed to external confidential documents until these controls and the production smoke test are signed off.
