-- Rekono schema. Contract: server/contracts/SCHEMA.md; enum values: server/contracts/index.ts.
-- Money is numeric(14,2). Every foreign key uses ON DELETE RESTRICT.
--
-- Organisation integrity: child rows reference parents by (organization_id, id), so a row can only
-- ever point at a parent in its own organisation, whatever connection writes it. Parents therefore
-- carry an extra unique (organization_id, id). Line-item tables have no organization_id and
-- inherit it from their parent (see the policies in 0002).

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.organization_memberships (
  user_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  role text not null constraint organization_memberships_role_check check (role in ('admin', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (user_id, organization_id)
);
create index organization_memberships_organization_id_idx on public.organization_memberships (organization_id);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  supplier_name text not null,
  normalized_name text not null,
  tax_identifier text,
  contact_information jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, normalized_name),
  unique (organization_id, id)
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  supplier_id uuid not null,
  purchase_order_number text not null,
  currency text not null,
  tax_amount numeric(14,2) not null,
  total_amount numeric(14,2) not null,
  status text not null default 'open', -- no PO status enum in contracts yet
  created_at timestamptz not null default now(),
  unique (organization_id, purchase_order_number),
  unique (organization_id, id),
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id) on delete restrict
);
create index purchase_orders_supplier_idx on public.purchase_orders (organization_id, supplier_id);
create index purchase_orders_status_idx on public.purchase_orders (organization_id, status);

create table public.purchase_order_line_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders (id) on delete restrict,
  line_number int not null,
  sku text,
  description text not null,
  quantity numeric(14,3) not null,
  unit_price numeric(14,2) not null,
  line_total numeric(14,2) not null,
  unique (purchase_order_id, line_number)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  supplier_id uuid,
  supplier_name_raw text,
  invoice_number text,
  invoice_date date,
  due_date date,
  po_reference text,
  purchase_order_id uuid,
  currency text,
  subtotal numeric(14,2),
  tax_amount numeric(14,2),
  total_amount numeric(14,2),
  status text not null default 'uploaded' constraint invoices_status_check check (status in (
    'uploaded', 'needs_extraction_review', 'validated', 'exception', 'resolved', 'rejected', 'superseded')),
  document_storage_path text not null,
  document_sha256 text not null,
  source_text text,
  extraction_confidence numeric(4,3) constraint invoices_extraction_confidence_check check (extraction_confidence between 0 and 1),
  extraction jsonb not null,
  supersedes_invoice_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id) on delete restrict,
  foreign key (organization_id, purchase_order_id) references public.purchase_orders (organization_id, id) on delete restrict,
  foreign key (organization_id, supersedes_invoice_id) references public.invoices (organization_id, id) on delete restrict
);
create index invoices_status_idx on public.invoices (organization_id, status);
create index invoices_invoice_number_idx on public.invoices (organization_id, invoice_number);
create index invoices_supplier_idx on public.invoices (organization_id, supplier_id);
create index invoices_purchase_order_idx on public.invoices (organization_id, purchase_order_id);
create index invoices_supersedes_idx on public.invoices (organization_id, supersedes_invoice_id);

create table public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  line_number int not null,
  sku text,
  description text not null,
  quantity numeric(14,3) not null,
  unit_price numeric(14,2) not null,
  line_total numeric(14,2) not null,
  tax_amount numeric(14,2),
  unique (invoice_id, line_number)
);

create table public.discrepancies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  invoice_id uuid not null,
  purchase_order_id uuid,
  discrepancy_type text not null constraint discrepancies_discrepancy_type_check check (discrepancy_type in (
    'duplicate_candidate', 'incorrect_total', 'line_arithmetic', 'tax_mismatch', 'unit_price_mismatch', 'quantity_mismatch',
    'unmatched_line', 'supplier_mismatch', 'missing_purchase_order', 'currency_mismatch', 'ambiguous_reference',
    'potential_extraction_error')),
  severity text not null constraint discrepancies_severity_check check (severity in ('low', 'medium', 'high')),
  expected_value text,
  observed_value text,
  difference_amount numeric(14,2),
  status text not null default 'open' constraint discrepancies_status_check check (status in (
    'open', 'investigating', 'awaiting_supplier', 'resolved', 'dismissed')),
  deterministic_evidence jsonb not null,
  evidence_hash text not null,
  created_at timestamptz not null default now(),
  unique (invoice_id, discrepancy_type, evidence_hash),
  unique (organization_id, id),
  foreign key (organization_id, invoice_id) references public.invoices (organization_id, id) on delete restrict,
  foreign key (organization_id, purchase_order_id) references public.purchase_orders (organization_id, id) on delete restrict
);
create index discrepancies_invoice_idx on public.discrepancies (organization_id, invoice_id);
create index discrepancies_purchase_order_idx on public.discrepancies (organization_id, purchase_order_id);
create index discrepancies_status_idx on public.discrepancies (organization_id, status);

create table public.ai_investigations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  discrepancy_id uuid not null,
  model_identifier text not null,
  prompt_version text not null,
  investigation_status text not null default 'queued' constraint ai_investigations_investigation_status_check check (
    investigation_status in ('queued', 'in_progress', 'completed', 'insufficient_evidence', 'failed')),
  evidence_hash text not null,
  evidence_references jsonb not null,
  findings jsonb,
  recommended_action text constraint ai_investigations_recommended_action_check check (recommended_action in (
    'approve_review_completion', 'request_corrected_invoice', 'request_supplier_clarification', 'investigate_duplicate',
    'verify_po_amendment', 'correct_extraction_error', 'escalate_to_reviewer', 'insufficient_evidence')),
  confidence text constraint ai_investigations_confidence_check check (confidence in ('low', 'medium', 'high')),
  error text,
  usage jsonb,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, discrepancy_id) references public.discrepancies (organization_id, id) on delete restrict
);
create unique index ai_investigations_live_key on public.ai_investigations (discrepancy_id, evidence_hash, prompt_version, model_identifier)
  where investigation_status <> 'failed';
create index ai_investigations_discrepancy_idx on public.ai_investigations (organization_id, discrepancy_id);
create index ai_investigations_status_idx on public.ai_investigations (organization_id, investigation_status);

create table public.resolution_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  discrepancy_id uuid not null,
  investigation_id uuid,
  proposed_action text constraint resolution_actions_proposed_action_check check (proposed_action in (
    'approve_review_completion', 'request_corrected_invoice', 'request_supplier_clarification', 'investigate_duplicate',
    'verify_po_amendment', 'correct_extraction_error', 'escalate_to_reviewer', 'insufficient_evidence')),
  approved_action text constraint resolution_actions_approved_action_check check (approved_action in (
    'approve_review_completion', 'request_corrected_invoice', 'request_supplier_clarification', 'investigate_duplicate',
    'verify_po_amendment', 'correct_extraction_error', 'escalate_to_reviewer', 'insufficient_evidence')),
  reviewer_id uuid not null,
  approval_status text not null constraint resolution_actions_approval_status_check check (approval_status in (
    'approved', 'rejected', 'more_info_requested')),
  reviewer_notes text not null default '',
  created_at timestamptz not null default now(),
  foreign key (organization_id, discrepancy_id) references public.discrepancies (organization_id, id) on delete restrict,
  foreign key (organization_id, investigation_id) references public.ai_investigations (organization_id, id) on delete restrict
);
create index resolution_actions_discrepancy_idx on public.resolution_actions (organization_id, discrepancy_id);
create index resolution_actions_investigation_idx on public.resolution_actions (organization_id, investigation_id);
create index resolution_actions_status_idx on public.resolution_actions (organization_id, approval_status);

create table public.supplier_message_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  discrepancy_id uuid not null,
  body text not null,
  evidence_references jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, discrepancy_id) references public.discrepancies (organization_id, id) on delete restrict
);
create index supplier_message_drafts_discrepancy_idx on public.supplier_message_drafts (organization_id, discrepancy_id);

create table public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  investigation_id uuid not null,
  tool_name text not null,
  arguments jsonb not null,
  ok boolean not null,
  duration_ms int not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, investigation_id) references public.ai_investigations (organization_id, id) on delete restrict
);
create index tool_calls_investigation_idx on public.tool_calls (organization_id, investigation_id);

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  actor_type text not null constraint audit_events_actor_type_check check (actor_type in ('user', 'agent', 'system')),
  actor_id text,
  event_type text not null,
  target_type text not null,
  target_id text not null,
  previous_state jsonb,
  new_state jsonb,
  "timestamp" timestamptz not null default now()
);
create index audit_events_target_idx on public.audit_events (organization_id, target_type, target_id);
create index audit_events_timestamp_idx on public.audit_events (organization_id, "timestamp");

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  status text not null default 'queued' constraint jobs_status_check check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts > 0),
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_status_run_after_idx on public.jobs (status, run_after);
create index jobs_organization_id_idx on public.jobs (organization_id);

create table public.idempotency_keys (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  key text not null,
  endpoint text not null,
  user_id uuid not null,
  response jsonb not null,
  status_code int not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, key, endpoint)
);

-- updated_at is always the server's time; callers cannot set or backdate it.
create function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();
create trigger jobs_set_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();
