-- =============================================================================
-- Phase 2 - service_role privileges
--
-- With auto-expose disabled, nothing in `public` is granted to anyone by
-- default, including `service_role`. BYPASSRLS lets service_role skip row
-- policies, but it does not skip the GRANT check, so the seed script failed
-- with "permission denied for table person".
--
-- This grants service_role what it needs on the existing objects, and sets
-- default privileges so tables added by later migrations are covered without
-- another patch like this one.
--
-- `anon` is granted nothing here, and the default privileges below explicitly
-- keep it that way for future tables too.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Schema access
--    Without USAGE on the schema the table grants below are unusable.
-- -----------------------------------------------------------------------------
grant usage on schema public to service_role;

-- The RLS helpers are SECURITY DEFINER, so triggers already run them as their
-- owner. This is only so a script can call them directly without a surprise.
grant usage on schema app to service_role;

-- -----------------------------------------------------------------------------
-- 2. Existing objects
-- -----------------------------------------------------------------------------
grant all privileges on all tables     in schema public to service_role;
grant all privileges on all sequences  in schema public to service_role;
grant execute         on all functions in schema public to service_role;
grant execute         on all functions in schema app    to service_role;

-- -----------------------------------------------------------------------------
-- 3. Future objects
--
--    ALTER DEFAULT PRIVILEGES is recorded per creating role. Migrations run as
--    `postgres`, so that is the role named here - objects created by anything
--    else are not covered and would need their own entry.
-- -----------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  grant all privileges on tables to service_role;

alter default privileges for role postgres in schema public
  grant all privileges on sequences to service_role;

alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- -----------------------------------------------------------------------------
-- 4. Keep `anon` empty
--
--    Nothing above touches anon. These two lines make that durable: if a later
--    migration or a Supabase default ever hands anon a privilege on a new
--    table, this default-privileges rule takes it straight back off.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;

alter default privileges for role postgres in schema public
  revoke all on tables from anon;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon;
