-- Row-level security, privileges, append-only triggers and the invoice-documents storage bucket.
--
-- Model: a row is visible to members of its organization_id; writes need role reviewer or admin;
-- memberships and the organisation itself are admin-only. User requests run as `authenticated`
-- with request.jwt.claims set; the server's privileged connection (postgres / service_role)
-- bypasses RLS and is the only thing that touches jobs and idempotency_keys.

-- ---------- membership lookup ----------
-- security definer so it can read memberships without recursing into their own policies.
create function public.current_role_in(org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_memberships m where m.organization_id = org and m.user_id = auth.uid()
$$;
revoke all on function public.current_role_in(uuid) from public, anon;
grant execute on function public.current_role_in(uuid) to authenticated, service_role;

-- ---------- table privileges (defence in depth under RLS) ----------
-- Supabase grants everything in `public` to anon and authenticated by default; narrow that to
-- exactly the operations the policies below allow.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select, update on public.organizations to authenticated;
-- Financial evidence is never deleted by users: discrepancies close by status, lines and POs are
-- evidence once stored. Only memberships (admin) and suppliers (RESTRICT when referenced) allow delete.
grant select, insert, update on
  public.invoices, public.invoice_line_items, public.purchase_orders, public.purchase_order_line_items,
  public.discrepancies, public.ai_investigations
  to authenticated;
grant select, insert, update, delete on public.organization_memberships, public.suppliers to authenticated;
grant select, insert on
  public.resolution_actions, public.supplier_message_drafts, public.tool_calls, public.audit_events
  to authenticated;
-- jobs, idempotency_keys: no grants and no policies for anon/authenticated.

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_line_items enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_line_items enable row level security;
alter table public.discrepancies enable row level security;
alter table public.ai_investigations enable row level security;
alter table public.resolution_actions enable row level security;
alter table public.supplier_message_drafts enable row level security;
alter table public.tool_calls enable row level security;
alter table public.audit_events enable row level security;
alter table public.jobs enable row level security;
alter table public.idempotency_keys enable row level security;

-- ---------- organizations: members read, admins rename; created only by the server ----------
create policy organizations_select on public.organizations for select to authenticated
  using (public.current_role_in(id) is not null);
create policy organizations_update on public.organizations for update to authenticated
  using (public.current_role_in(id) = 'admin') with check (public.current_role_in(id) = 'admin');

-- ---------- organization_memberships: members read, admins write ----------
create policy memberships_select on public.organization_memberships for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy memberships_insert on public.organization_memberships for insert to authenticated
  with check (public.current_role_in(organization_id) = 'admin');
create policy memberships_update on public.organization_memberships for update to authenticated
  using (public.current_role_in(organization_id) = 'admin') with check (public.current_role_in(organization_id) = 'admin');
create policy memberships_delete on public.organization_memberships for delete to authenticated
  using (public.current_role_in(organization_id) = 'admin');

-- ---------- mutable organisation data ----------
create policy suppliers_select on public.suppliers for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy suppliers_insert on public.suppliers for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));
create policy suppliers_update on public.suppliers for update to authenticated
  using (public.current_role_in(organization_id) in ('admin', 'reviewer'))
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));
create policy suppliers_delete on public.suppliers for delete to authenticated
  using (public.current_role_in(organization_id) in ('admin', 'reviewer'));

create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy purchase_orders_insert on public.purchase_orders for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));
create policy purchase_orders_update on public.purchase_orders for update to authenticated
  using (public.current_role_in(organization_id) in ('admin', 'reviewer'))
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

-- invoices: no delete policy (and no delete grant). Invoices are superseded, never removed.
create policy invoices_select on public.invoices for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy invoices_insert on public.invoices for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));
create policy invoices_update on public.invoices for update to authenticated
  using (public.current_role_in(organization_id) in ('admin', 'reviewer'))
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

create policy discrepancies_select on public.discrepancies for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy discrepancies_insert on public.discrepancies for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));
create policy discrepancies_update on public.discrepancies for update to authenticated
  using (public.current_role_in(organization_id) in ('admin', 'reviewer'))
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

create policy ai_investigations_select on public.ai_investigations for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy ai_investigations_insert on public.ai_investigations for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));
create policy ai_investigations_update on public.ai_investigations for update to authenticated
  using (public.current_role_in(organization_id) in ('admin', 'reviewer'))
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

-- ---------- line items: organisation comes from the parent row ----------
create policy invoice_line_items_select on public.invoice_line_items for select to authenticated
  using (public.current_role_in((select i.organization_id from public.invoices i where i.id = invoice_id)) is not null);
create policy invoice_line_items_insert on public.invoice_line_items for insert to authenticated
  with check (public.current_role_in((select i.organization_id from public.invoices i where i.id = invoice_id)) in ('admin', 'reviewer'));
create policy invoice_line_items_update on public.invoice_line_items for update to authenticated
  using (public.current_role_in((select i.organization_id from public.invoices i where i.id = invoice_id)) in ('admin', 'reviewer'))
  with check (public.current_role_in((select i.organization_id from public.invoices i where i.id = invoice_id)) in ('admin', 'reviewer'));

create policy purchase_order_line_items_select on public.purchase_order_line_items for select to authenticated
  using (public.current_role_in((select p.organization_id from public.purchase_orders p where p.id = purchase_order_id)) is not null);
create policy purchase_order_line_items_insert on public.purchase_order_line_items for insert to authenticated
  with check (public.current_role_in((select p.organization_id from public.purchase_orders p where p.id = purchase_order_id)) in ('admin', 'reviewer'));
create policy purchase_order_line_items_update on public.purchase_order_line_items for update to authenticated
  using (public.current_role_in((select p.organization_id from public.purchase_orders p where p.id = purchase_order_id)) in ('admin', 'reviewer'))
  with check (public.current_role_in((select p.organization_id from public.purchase_orders p where p.id = purchase_order_id)) in ('admin', 'reviewer'));

-- ---------- append-only evidence: read and insert only ----------
create policy resolution_actions_select on public.resolution_actions for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy resolution_actions_insert on public.resolution_actions for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

create policy supplier_message_drafts_select on public.supplier_message_drafts for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy supplier_message_drafts_insert on public.supplier_message_drafts for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

create policy tool_calls_select on public.tool_calls for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy tool_calls_insert on public.tool_calls for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

create policy audit_events_select on public.audit_events for select to authenticated
  using (public.current_role_in(organization_id) is not null);
create policy audit_events_insert on public.audit_events for insert to authenticated
  with check (public.current_role_in(organization_id) in ('admin', 'reviewer'));

-- Triggers fire for every role, including the table owner and superusers.
create function public.reject_append_only_change() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op;
end $$;

create trigger resolution_actions_append_only before update or delete on public.resolution_actions
  for each row execute function public.reject_append_only_change();
create trigger resolution_actions_no_truncate before truncate on public.resolution_actions
  for each statement execute function public.reject_append_only_change();
create trigger supplier_message_drafts_append_only before update or delete on public.supplier_message_drafts
  for each row execute function public.reject_append_only_change();
create trigger supplier_message_drafts_no_truncate before truncate on public.supplier_message_drafts
  for each statement execute function public.reject_append_only_change();
create trigger tool_calls_append_only before update or delete on public.tool_calls
  for each row execute function public.reject_append_only_change();
create trigger tool_calls_no_truncate before truncate on public.tool_calls
  for each statement execute function public.reject_append_only_change();
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function public.reject_append_only_change();
create trigger audit_events_no_truncate before truncate on public.audit_events
  for each statement execute function public.reject_append_only_change();

-- ---------- storage: invoice-documents ----------
-- Object path: <organization_id>/<invoice_id>/<sha256>. Returns the organisation for a well-formed
-- path and null otherwise, so malformed paths match no policy instead of raising a cast error.
create function public.invoice_document_org(object_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
    then split_part(object_name, '/', 1)::uuid
  end
$$;

-- Guarded so this file also applies where Supabase Storage is absent (plain Postgres, PGlite).
do $storage$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    -- limits mirror UPLOAD_MAX_BYTES and UPLOAD_MIME_TYPES in server/contracts/index.ts
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('invoice-documents', 'invoice-documents', false, 3145728,
            array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/json', 'text/plain'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

    create policy invoice_documents_member_select on storage.objects for select to authenticated
      using (bucket_id = 'invoice-documents' and public.current_role_in(public.invoice_document_org(name)) is not null);
    create policy invoice_documents_reviewer_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'invoice-documents'
        and public.current_role_in(public.invoice_document_org(name)) in ('admin', 'reviewer'));
    -- no update or delete policy: stored documents are never overwritten or removed by users.
  end if;
end
$storage$;
