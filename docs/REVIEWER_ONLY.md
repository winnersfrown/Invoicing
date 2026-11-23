# Reviewer-only demo rollout

The homepage remains public. **Try the demo** opens the account gateway. A verified new account gets one private organization, one synthetic invoice and one synthetic purchase order. The workspace endpoint checks membership under a per-user transaction lock, so signing back in or retrying does not create another organization or another set of samples.

## Dependencies reviewed

- `0001_schema.sql` defines the three historical role values in the membership constraint. It also stores actor and reviewer identifiers on audit and resolution records.
- `0002_policies.sql` uses `current_role_in` for organization-scoped reads, Reviewer or Admin financial writes, legacy Admin membership writes, and organization-scoped document storage.
- `0003_invoice_management.sql` checks membership for PO unlinking and invoice archiving. It records the authenticated actor.
- The application contract, membership lookup, workspace provisioning, API router, account gateway and local dev server now expose one user role. Cron and public configuration keep their separate authorization paths.
- `0004_reviewer_only.sql` adds a Reviewer-only constraint after converting eligible memberships. Existing RLS, storage policies, legacy role definitions, and historical migrations remain intact.

## Preflight before an approved production rollout

Run this read-only query and review any shared organization it returns before proceeding.

```sql
select organization_id, count(*) as members,
       count(*) filter (where role in ('admin','viewer')) as legacy_memberships
from public.organization_memberships
group by organization_id
having count(*) > 1 and count(*) filter (where role in ('admin','viewer')) > 0;
```

On November 23, 2026, the read-only production preflight found zero shared organizations with legacy roles and zero sole-member legacy memberships. Recheck immediately before rollout. The migration locks membership writes and aborts if it finds any shared legacy memberships. It preserves the organization, user, and creation timestamp of every converted membership and records its prior role in the audit log.

After approval, apply migration 0004 before deploying the application. Keep the existing public signup configuration, including email verification and permitted redirects. Verify registration, returning sign-in, sample invoice and PO visibility, and invoice review on production using designated test accounts.

A rollback that needs legacy role assignment requires restoring the previous application and removing the added Reviewer-only constraint. Do not replay old roles automatically. The role-change audit events provide the original values for an explicitly approved restoration.
