-- Stage 1: the old server continues to function until the stage 2 cutover.
create role sorikano_workflow nologin noinherit nobypassrls;
-- The migration owner is the existing trusted server login (postgres in Supabase).
grant sorikano_workflow to current_user;
grant usage on schema public, auth, sorikano_private to sorikano_workflow;
grant execute on function auth.uid(), public.current_role_in(uuid),
  sorikano_private.unlink_invoice_purchase_order(uuid, uuid, uuid) to sorikano_workflow;

grant select, insert on public.suppliers to sorikano_workflow;
alter policy suppliers_select on public.suppliers to authenticated, sorikano_workflow;
alter policy suppliers_insert on public.suppliers to authenticated, sorikano_workflow;

grant select, insert on public.purchase_orders to sorikano_workflow;
alter policy purchase_orders_select on public.purchase_orders to authenticated, sorikano_workflow;
alter policy purchase_orders_insert on public.purchase_orders to authenticated, sorikano_workflow;

grant select, insert on public.purchase_order_line_items to sorikano_workflow;
alter policy purchase_order_line_items_select on public.purchase_order_line_items to authenticated, sorikano_workflow;
alter policy purchase_order_line_items_insert on public.purchase_order_line_items to authenticated, sorikano_workflow;

grant select, insert, update (supplier_id, purchase_order_id, status, supplier_name_raw, currency, po_reference, extraction, archived_at) on public.invoices to sorikano_workflow;
alter policy invoices_select on public.invoices to authenticated, sorikano_workflow;
alter policy invoices_insert on public.invoices to authenticated, sorikano_workflow;
alter policy invoices_update on public.invoices to authenticated, sorikano_workflow;

grant select, insert on public.invoice_line_items to sorikano_workflow;
alter policy invoice_line_items_select on public.invoice_line_items to authenticated, sorikano_workflow;
alter policy invoice_line_items_insert on public.invoice_line_items to authenticated, sorikano_workflow;

grant select, insert, update (status) on public.discrepancies to sorikano_workflow;
alter policy discrepancies_select on public.discrepancies to authenticated, sorikano_workflow;
alter policy discrepancies_insert on public.discrepancies to authenticated, sorikano_workflow;
alter policy discrepancies_update on public.discrepancies to authenticated, sorikano_workflow;

grant select, insert (organization_id, discrepancy_id, model_identifier, prompt_version, investigation_status, evidence_hash, evidence_references, requested_by) on public.ai_investigations to sorikano_workflow;
alter policy ai_investigations_select on public.ai_investigations to authenticated, sorikano_workflow;
alter policy ai_investigations_insert on public.ai_investigations to authenticated, sorikano_workflow;

grant select, insert on public.resolution_actions to sorikano_workflow;
alter policy resolution_actions_select on public.resolution_actions to authenticated, sorikano_workflow;
alter policy resolution_actions_insert on public.resolution_actions to authenticated, sorikano_workflow;

grant select, insert on public.supplier_message_drafts to sorikano_workflow;
alter policy supplier_message_drafts_select on public.supplier_message_drafts to authenticated, sorikano_workflow;
alter policy supplier_message_drafts_insert on public.supplier_message_drafts to authenticated, sorikano_workflow;

grant select on public.tool_calls to sorikano_workflow;
alter policy tool_calls_select on public.tool_calls to authenticated, sorikano_workflow;

grant select, insert (organization_id, actor_type, actor_id, event_type, target_type, target_id, previous_state, new_state) on public.audit_events to sorikano_workflow;
alter policy audit_events_select on public.audit_events to authenticated, sorikano_workflow;
alter policy audit_events_insert on public.audit_events to authenticated, sorikano_workflow;

grant select on public.invoice_po_unlinks to sorikano_workflow;
alter policy invoice_po_unlinks_select on public.invoice_po_unlinks to authenticated, sorikano_workflow;

grant select on public.organizations to sorikano_workflow;
alter policy organizations_select on public.organizations to authenticated, sorikano_workflow;

-- User-request handlers can only attribute events and decisions to their verified caller.
-- Background jobs use the existing trusted system context.
create policy workflow_audit_actor on public.audit_events as restrictive for insert to sorikano_workflow
  with check (actor_type = 'user' and actor_id = auth.uid()::text);
create policy workflow_resolution_actor on public.resolution_actions as restrictive for insert to sorikano_workflow
  with check (reviewer_id = auth.uid());

create policy workflow_invoice_creator on public.invoices as restrictive for insert to sorikano_workflow
  with check (created_by = auth.uid() and status = 'uploaded');
create policy workflow_investigation_request on public.ai_investigations as restrictive for insert to sorikano_workflow
  with check (requested_by = auth.uid() and investigation_status = 'queued');
create policy workflow_draft_actor on public.supplier_message_drafts as restrictive for insert to sorikano_workflow
  with check (created_by = auth.uid());
