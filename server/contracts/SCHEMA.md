# Database contract

Table and column names are fixed here so the migration and the data-access code agree. Types are Postgres. Every `id` is `uuid default gen_random_uuid()` unless noted. Money is `numeric(14,2)`. Enum-like columns are `text` with a `check` listing the values from `server/contracts/index.ts`.

```
organizations              id, name, created_at
organization_memberships   user_id, organization_id, role, created_at            pk(user_id, organization_id)
suppliers                  id, organization_id, supplier_name, normalized_name, tax_identifier, contact_information jsonb, created_at
                           unique(organization_id, normalized_name)
invoices                   id, organization_id, supplier_id?, supplier_name_raw?, invoice_number?, invoice_date?, due_date?,
                           po_reference?, purchase_order_id?, currency?, subtotal?, tax_amount?, total_amount?, status,
                           document_storage_path, document_sha256, source_text?, extraction_confidence numeric(4,3)?,
                           extraction jsonb, supersedes_invoice_id?, created_by, created_at, updated_at
invoice_line_items         id, invoice_id, line_number int, sku?, description, quantity numeric(14,3), unit_price, line_total, tax_amount?
                           unique(invoice_id, line_number)
purchase_orders            id, organization_id, supplier_id, purchase_order_number, currency, tax_amount, total_amount, status, created_at
                           unique(organization_id, purchase_order_number)
purchase_order_line_items  id, purchase_order_id, line_number int, sku?, description, quantity numeric(14,3), unit_price, line_total
discrepancies              id, organization_id, invoice_id, purchase_order_id?, discrepancy_type, severity, expected_value text?,
                           observed_value text?, difference_amount?, status, deterministic_evidence jsonb, evidence_hash text, created_at
                           unique(invoice_id, discrepancy_type, evidence_hash)
ai_investigations          id, organization_id, discrepancy_id, model_identifier, prompt_version, investigation_status,
                           evidence_hash text, evidence_references jsonb, findings jsonb?, recommended_action?, confidence?,
                           error text?, usage jsonb?, requested_by, created_at, completed_at?
                           unique(discrepancy_id, evidence_hash, prompt_version, model_identifier) where investigation_status <> 'failed'
resolution_actions         id, organization_id, discrepancy_id, investigation_id?, proposed_action?, approved_action?,
                           reviewer_id, approval_status, reviewer_notes, created_at
supplier_message_drafts    id, organization_id, discrepancy_id, body, evidence_references jsonb, created_by, created_at
tool_calls                 id, organization_id, investigation_id, tool_name, arguments jsonb, ok bool, duration_ms int, created_at
audit_events               id bigint identity, organization_id, actor_type, actor_id text?, event_type, target_type, target_id text,
                           previous_state jsonb?, new_state jsonb?, "timestamp" timestamptz default now()
jobs                       id, organization_id, kind, payload jsonb, idempotency_key text unique, status, attempts int, max_attempts int,
                           run_after timestamptz, locked_until timestamptz?, last_error text?, created_at, updated_at
idempotency_keys           organization_id, key, endpoint, user_id, response jsonb, status_code int, created_at
                           pk(organization_id, key, endpoint)
```

`?` means nullable.

## Rules the migration must enforce

- Row-level security on every table. A row is visible only to members of its `organization_id`. Child tables without the column (`invoice_line_items`, `purchase_order_line_items`) check through their parent.
- Migration 0004 constrains memberships to Reviewer. After 0006, browser roles have no application table privileges. Provisioning runs in the trusted server context.
- `audit_events`, `resolution_actions`, `tool_calls` and `supplier_message_drafts` are append-only: a trigger raises on `update` or `delete` for every role.
- Invoices and their documents are never deleted: no `delete` policy, and foreign keys from evidence tables use `on delete restrict`.
- `jobs` and `idempotency_keys` have no policies for `authenticated`; only the server's privileged connection touches them.
- Helper `public.current_role_in(org uuid) returns text` (security definer, stable) reads the caller's membership using `auth.uid()`.
- Storage bucket `invoice-documents` is private. Object path is `<organization_id>/<invoice_id>/<sha256>`; the backend uploads new objects and signs canonical paths after authorization. Browser roles have no object policies for this bucket.

## Connection model

Server code talks SQL through one small `Db` interface (`query`, `transaction`). In production it is `pg` against the Supabase pooler; in tests it is PGlite. For a user request the server opens a transaction and runs `set local role sorikano_workflow` plus `select set_config('request.jwt.claims', <claims json>, true)` so the policies above apply to that request. Application code still filters by organisation; the policies are the backstop.
