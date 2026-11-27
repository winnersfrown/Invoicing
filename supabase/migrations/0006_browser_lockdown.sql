-- Stage 2: apply only after all application instances use sorikano_workflow.
revoke all on public.organizations, public.organization_memberships, public.suppliers,
  public.purchase_orders, public.purchase_order_line_items, public.invoices, public.invoice_line_items,
  public.discrepancies, public.ai_investigations, public.resolution_actions, public.supplier_message_drafts,
  public.tool_calls, public.audit_events, public.invoice_po_unlinks, public.jobs, public.idempotency_keys
  from public, anon, authenticated;
revoke execute on function public.current_role_in(uuid) from authenticated, service_role;
revoke execute on function sorikano_private.unlink_invoice_purchase_order(uuid, uuid, uuid) from authenticated;
revoke usage on schema sorikano_private from authenticated;

do $storage$
begin
  if to_regclass('storage.objects') is not null then
    drop policy invoice_documents_member_select on storage.objects;
    drop policy invoice_documents_reviewer_insert on storage.objects;
  end if;
end
$storage$;
