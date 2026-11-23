-- Keep old role definitions and RLS policies for rollback. Constrain new values
-- after safely converting existing sole-member organizations and recording the changes.
do $migration$
begin
  lock table public.organization_memberships in share row exclusive mode;

  if exists (
    select 1
    from public.organization_memberships
    group by organization_id
    having count(*) > 1 and bool_or(role in ('admin', 'viewer'))
  ) then
    raise exception 'Shared organizations have legacy roles. Review those memberships before running this migration.';
  end if;

  insert into public.audit_events (
    organization_id, actor_type, event_type, target_type, target_id, previous_state, new_state
  )
  select organization_id, 'system', 'membership.role_changed', 'organization_membership',
    user_id::text, jsonb_build_object('role', role), jsonb_build_object('role', 'reviewer')
  from public.organization_memberships
  where role in ('admin', 'viewer');

  update public.organization_memberships set role = 'reviewer' where role in ('admin', 'viewer');
  alter table public.organization_memberships
    add constraint organization_memberships_reviewer_only_check check (role = 'reviewer');
end
$migration$;
