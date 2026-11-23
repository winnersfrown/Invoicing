-- Archive metadata is independent of financial status. Existing invoices stay active.
alter table public.invoices
  add column archived_at timestamptz,
  add column archived_by uuid,
  add constraint invoices_archive_metadata_check check ((archived_at is null) = (archived_by is null));

create index invoices_archive_idx on public.invoices (organization_id, archived_at, created_at desc);

-- A reviewer decision applies to the exact invoice and PO, even if the reference is edited
-- or the invoice is archived and restored. Both records remain available for audit.
create table public.invoice_po_unlinks (
  organization_id uuid not null,
  invoice_id uuid not null,
  purchase_order_id uuid not null,
  unlinked_by uuid not null,
  unlinked_at timestamptz not null default now(),
  primary key (organization_id, invoice_id, purchase_order_id),
  foreign key (organization_id, invoice_id) references public.invoices (organization_id, id) on delete restrict,
  foreign key (organization_id, purchase_order_id) references public.purchase_orders (organization_id, id) on delete restrict
);

alter table public.invoice_po_unlinks enable row level security;
revoke all on public.invoice_po_unlinks from public, anon, authenticated;
grant select on public.invoice_po_unlinks to authenticated;
create policy invoice_po_unlinks_select on public.invoice_po_unlinks for select to authenticated
  using (public.current_role_in(organization_id) is not null);

create schema if not exists sorikano_private;
revoke all on schema sorikano_private from public, anon, authenticated;
grant usage on schema sorikano_private to authenticated;

-- Record database-derived author and time, including for writes via the Data API.
create function sorikano_private.record_invoice_archive() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if new.archived_at is not null or new.archived_by is not null then
      raise exception 'Create the invoice before archiving it' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.archived_at is not distinct from old.archived_at and new.archived_by is not distinct from old.archived_by then
    return new;
  end if;
  if actor is null or coalesce(public.current_role_in(old.organization_id), '') not in ('admin', 'reviewer') then
    raise exception 'Archive changes require an authorized reviewer' using errcode = '42501';
  end if;
  if (old.archived_at is null) = (new.archived_at is null) then
    raise exception 'Archive metadata cannot be edited' using errcode = '23514';
  end if;
  if new.archived_at is null then
    new.archived_by := null;
  else
    new.archived_at := now();
    new.archived_by := actor;
  end if;
  insert into public.audit_events (organization_id, actor_type, actor_id, event_type, target_type, target_id, previous_state, new_state)
  values (old.organization_id, 'user', actor::text, case when new.archived_at is null then 'invoice.restored' else 'invoice.archived' end,
    'invoice', old.id::text, jsonb_build_object('archived_at', old.archived_at, 'archived_by', old.archived_by),
    jsonb_build_object('archived_at', new.archived_at, 'archived_by', new.archived_by));
  return new;
end;
$$;
revoke all on function sorikano_private.record_invoice_archive() from public, anon, authenticated;
create trigger record_invoice_archive before insert or update of archived_at, archived_by on public.invoices
  for each row execute function sorikano_private.record_invoice_archive();

create function sorikano_private.guard_unlinked_po() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.purchase_order_id is not null and exists (
    select 1 from public.invoice_po_unlinks u where u.organization_id = new.organization_id
      and u.invoice_id = new.id and u.purchase_order_id = new.purchase_order_id
  ) then
    raise exception 'The reviewer unlinked this purchase order' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function sorikano_private.guard_unlinked_po() from public, anon, authenticated;
create trigger guard_unlinked_po before insert or update of purchase_order_id on public.invoices
  for each row execute function sorikano_private.guard_unlinked_po();

create function sorikano_private.unlink_invoice_purchase_order(org uuid, invoice uuid, purchase_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  current_po uuid;
  archive_time timestamptz;
begin
  if actor is null or coalesce(public.current_role_in(org), '') not in ('admin', 'reviewer') then
    raise exception 'Invoice unavailable' using errcode = '42501';
  end if;
  select i.purchase_order_id, i.archived_at into current_po, archive_time
    from public.invoices i where i.organization_id = org and i.id = invoice for update;
  if not found then
    raise exception 'Invoice unavailable' using errcode = '42501';
  end if;
  if archive_time is not null or purchase_order is null or current_po is distinct from purchase_order then
    raise exception 'The linked purchase order changed' using errcode = '23514';
  end if;
  insert into public.invoice_po_unlinks (organization_id, invoice_id, purchase_order_id, unlinked_by)
  values (org, invoice, purchase_order, actor);
  update public.invoices set purchase_order_id = null where organization_id = org and id = invoice;
  insert into public.audit_events (organization_id, actor_type, actor_id, event_type, target_type, target_id, previous_state, new_state)
  values (org, 'user', actor::text, 'invoice.purchase_order_unlinked', 'invoice', invoice::text,
    jsonb_build_object('purchase_order_id', purchase_order), jsonb_build_object('purchase_order_id', null));
end;
$$;
revoke all on function sorikano_private.unlink_invoice_purchase_order(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function sorikano_private.unlink_invoice_purchase_order(uuid, uuid, uuid) to authenticated;
