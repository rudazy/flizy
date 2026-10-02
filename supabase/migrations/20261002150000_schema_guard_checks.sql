-- Schema guard, part 2: named check constraints.
--
-- The startup guard (20260812000000_schema_guard.sql, lib/schemaGuard.js) checked
-- tables, views, functions and triggers. A rule inside a table was invisible to
-- it: when the "> 0" check on transfers.amount_eth was relaxed for marketplace
-- rows (20261002130000), a database without that change still passed the guard,
-- and there every NFT listing failed with a generic error. This adds each
-- table's named check constraints to what the guard reads, as table.name.
--
-- A guard can only compare names, and twelve rules had been changed in place
-- under the same name, so their old and new versions were indistinguishable.
-- Each is renamed below to <name>_v2, but only after its definition is checked
-- to be the latest one: an older version stops this migration and names the
-- migration to apply first. From here on a changed rule gets a new name
-- (test/schemaChecks.test.js fails otherwise), so one name is one definition.
--
-- The last block asserts that every check constraint the code requires is in
-- this database. A database that is behind fails here, by name, instead of
-- failing the guard at the next deploy.
--
-- Re-running is safe. Applying 20261002130000 again after this one fails and
-- rolls back without changes, because the rule it would add exists as _v2.

-- ---------------------------------------------------------------------------
-- 1. Introspection function, now with check constraints
-- ---------------------------------------------------------------------------

create or replace function public.schema_guard_objects()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    ),
    'views', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
    ),
    'functions', (
      select coalesce(jsonb_agg(distinct p.proname order by p.proname), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    ),
    'triggers', (
      select coalesce(jsonb_agg(t.tgname order by t.tgname), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
    ),
    'checks', (
      select coalesce(jsonb_agg(c.relname || '.' || k.conname order by c.relname, k.conname), '[]'::jsonb)
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and k.contype = 'c'
    ),
    'rls_enabled', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    ),
    -- Reported for diagnosis, not enforced: required columns are not reliably
    -- derivable from supabase-js call sites, so nothing fails on this key.
    'columns', (
      select coalesce(jsonb_object_agg(x.relname, x.cols), '{}'::jsonb)
      from (
        select c.relname, jsonb_agg(a.attname order by a.attnum) as cols
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public'
          and c.relkind in ('r', 'v', 'm')
          and a.attnum > 0
          and not a.attisdropped
        group by c.relname
      ) x
    )
  );
$$;

comment on function public.schema_guard_objects() is
  'Startup schema guard introspection. Returns public-schema object, check constraint and column names for the deploy-time check in lib/schemaGuard.js. Read only, no row data.';

revoke all on function public.schema_guard_objects() from public;
revoke all on function public.schema_guard_objects() from anon, authenticated;
grant execute on function public.schema_guard_objects() to service_role;

-- ---------------------------------------------------------------------------
-- 2. Rules that were changed under the same name get a new one
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.transfers'::regclass and conname = 'transfers_amount_eth_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.transfers'::regclass and conname = 'transfers_amount_eth_check'
        and pg_get_constraintdef(oid) like '%nft_market%'
    ) then
      raise exception 'transfers.transfers_amount_eth_check is an older version: apply 20261002130000_transfers_nft_market_zero.sql first';
    end if;
    alter table public.transfers rename constraint transfers_amount_eth_check to transfers_amount_eth_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.channel_identities'::regclass and conname = 'channel_identities_channel_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.channel_identities'::regclass and conname = 'channel_identities_channel_check'
        and pg_get_constraintdef(oid) like '%discord%'
    ) then
      raise exception 'channel_identities.channel_identities_channel_check is an older version: apply 20260801120000_platform_channels.sql first';
    end if;
    alter table public.channel_identities rename constraint channel_identities_channel_check to channel_identities_channel_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.sessions'::regclass and conname = 'sessions_channel_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.sessions'::regclass and conname = 'sessions_channel_check'
        and pg_get_constraintdef(oid) like '%discord%'
    ) then
      raise exception 'sessions.sessions_channel_check is an older version: apply 20260801120000_platform_channels.sql first';
    end if;
    alter table public.sessions rename constraint sessions_channel_check to sessions_channel_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.claims'::regclass and conname = 'claims_invite_code_format'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.claims'::regclass and conname = 'claims_invite_code_format'
        and pg_get_constraintdef(oid) like '%{2,23}%'
    ) then
      raise exception 'claims.claims_invite_code_format is an older version: apply 20260814000000_invite_username_refs.sql first';
    end if;
    alter table public.claims rename constraint claims_invite_code_format to claims_invite_code_format_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.claims'::regclass and conname = 'claims_recipient_mode_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.claims'::regclass and conname = 'claims_recipient_mode_check'
        and pg_get_constraintdef(oid) like '%to_email%'
    ) then
      raise exception 'claims.claims_recipient_mode_check is an older version: apply 20260805120000_claim_email_recipient.sql first';
    end if;
    alter table public.claims rename constraint claims_recipient_mode_check to claims_recipient_mode_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.invite_attributions'::regclass and conname = 'invite_attributions_source_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.invite_attributions'::regclass and conname = 'invite_attributions_source_check'
        and pg_get_constraintdef(oid) like '%claim_link%'
    ) then
      raise exception 'invite_attributions.invite_attributions_source_check is an older version: apply 20260813010000_claim_invite_attach.sql first';
    end if;
    alter table public.invite_attributions rename constraint invite_attributions_source_check to invite_attributions_source_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.invite_codes'::regclass and conname = 'invite_codes_code_format'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.invite_codes'::regclass and conname = 'invite_codes_code_format'
        and pg_get_constraintdef(oid) like '%{2,23}%'
    ) then
      raise exception 'invite_codes.invite_codes_code_format is an older version: apply 20260814000000_invite_username_refs.sql first';
    end if;
    alter table public.invite_codes rename constraint invite_codes_code_format to invite_codes_code_format_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.pay_codes'::regclass and conname = 'pay_codes_code_format'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.pay_codes'::regclass and conname = 'pay_codes_code_format'
        and pg_get_constraintdef(oid) like '%{9}%'
    ) then
      raise exception 'pay_codes.pay_codes_code_format is an older version: apply 20260901000000_pay_code_9_digit.sql first';
    end if;
    alter table public.pay_codes rename constraint pay_codes_code_format to pay_codes_code_format_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_requests'::regclass and conname = 'payment_requests_status_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.payment_requests'::regclass and conname = 'payment_requests_status_check'
        and pg_get_constraintdef(oid) like '%declined%'
    ) then
      raise exception 'payment_requests.payment_requests_status_check is an older version: apply 20260908010000_request_declined.sql first';
    end if;
    alter table public.payment_requests rename constraint payment_requests_status_check to payment_requests_status_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.claims'::regclass and conname = 'claims_status_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.claims'::regclass and conname = 'claims_status_check'
        and pg_get_constraintdef(oid) like '%processing%'
    ) then
      raise exception 'claims.claims_status_check is an older version: apply 20260729100000_claim_processing_status.sql first';
    end if;
    alter table public.claims rename constraint claims_status_check to claims_status_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.notifications'::regclass and conname = 'notifications_channel_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.notifications'::regclass and conname = 'notifications_channel_check'
        and pg_get_constraintdef(oid) like '%discord%'
    ) then
      raise exception 'notifications.notifications_channel_check is an older version: apply 20260801120000_platform_channels.sql first';
    end if;
    alter table public.notifications rename constraint notifications_channel_check to notifications_channel_check_v2;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.email_verifications'::regclass and conname = 'email_verifications_purpose_check'
  ) then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.email_verifications'::regclass and conname = 'email_verifications_purpose_check'
        and pg_get_constraintdef(oid) like '%login%'
    ) then
      raise exception 'email_verifications.email_verifications_purpose_check is an older version: apply 20260815000000_email_verify_login_purpose.sql first';
    end if;
    alter table public.email_verifications rename constraint email_verifications_purpose_check to email_verifications_purpose_check_v2;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions
-- ---------------------------------------------------------------------------

do $$
declare
  payload jsonb;
  missing text;
begin
  if has_function_privilege('anon', 'public.schema_guard_objects()', 'execute') then
    raise exception 'anon can still execute schema_guard_objects';
  end if;

  if not has_function_privilege('service_role', 'public.schema_guard_objects()', 'execute') then
    raise exception 'service_role cannot execute schema_guard_objects';
  end if;

  payload := public.schema_guard_objects();
  if payload is null or jsonb_typeof(payload -> 'checks') <> 'array' then
    raise exception 'schema_guard_objects did not return a checks array';
  end if;

  -- Every check constraint the site and the bots require, as derived from this
  -- repo when this migration was written (lib/schemaRequirements.js).
  select string_agg(r, ', ' order by r) into missing
  from unnest(array[
    'account_emails.account_emails_email_format',
    'account_tokens.account_tokens_address_check',
    'account_tokens.account_tokens_decimals_check',
    'account_tokens.account_tokens_symbol_check',
    'channel_identities.channel_identities_channel_check_v2',
    'channel_identities.whatsapp_identities_sender_nonempty',
    'claims.claims_asset_token_consistency',
    'claims.claims_invite_code_format_v2',
    'claims.claims_nft_token_id_shape',
    'claims.claims_recipient_mode_check_v2',
    'claims.claims_status_check_v2',
    'claims.claims_to_channel_check',
    'contacts.contacts_alias_format',
    'contacts.contacts_alias_nonempty',
    'copy_setups.copy_setups_allocation_wei_check',
    'copy_setups.copy_setups_bounds_check',
    'copy_setups.copy_setups_count_check',
    'copy_setups.copy_setups_kind_check',
    'copy_setups.copy_setups_max_daily_wei_check',
    'copy_setups.copy_setups_max_trade_wei_check',
    'copy_setups.copy_setups_per_trade_wei_check',
    'copy_setups.copy_setups_slippage_check',
    'copy_wallets.copy_wallets_address_check',
    'copy_wallets.copy_wallets_kind_check',
    'copy_wallets.copy_wallets_label_check',
    'copy_wallets.copy_wallets_position_check',
    'email_verifications.email_verifications_email_format',
    'email_verifications.email_verifications_purpose_check_v2',
    'identity_events.identity_events_channel_check',
    'identity_events.identity_events_event_type_check',
    'invite_attributions.invite_attributions_blocked_reason_check',
    'invite_attributions.invite_attributions_not_self',
    'invite_attributions.invite_attributions_source_check_v2',
    'invite_codes.invite_codes_code_format_v2',
    'invite_events.invite_events_event_type_check',
    'invite_phone_claims.invite_phone_claims_phone_format',
    'limit_orders.limit_orders_amount_in_check',
    'limit_orders.limit_orders_error_check',
    'limit_orders.limit_orders_expiry_check',
    'limit_orders.limit_orders_min_out_check',
    'limit_orders.limit_orders_side_check',
    'limit_orders.limit_orders_status_check',
    'limit_orders.limit_orders_tx_hash_check',
    'link_codes.link_codes_code_format',
    'nft_favorites.nft_favorites_collection_check',
    'nft_favorites.nft_favorites_token_id_check',
    'nft_offer_declines.nft_offer_declines_marketplace_check',
    'nft_offer_declines.nft_offer_declines_offer_id_check',
    'notifications.notifications_channel_check_v2',
    'pay_codes.pay_codes_code_format_v2',
    'payment_requests.payment_requests_from_channel_check',
    'payment_requests.payment_requests_paid_amount_range_check',
    'payment_requests.payment_requests_recipient_mode_check',
    'payment_requests.payment_requests_status_check_v2',
    'pots.pots_closed_at_check',
    'pots.pots_code_not_blank_check',
    'pots.pots_name_not_blank_check',
    'pots.pots_status_check',
    'pots.pots_target_positive_check',
    'projects.projects_description_len',
    'projects.projects_handle_format',
    'projects.projects_links_is_array',
    'projects.projects_name_len',
    'reserved_usernames.reserved_usernames_category_nonempty',
    'reserved_usernames.reserved_usernames_normalized_name_nonempty',
    'sessions.sessions_channel_check_v2',
    'task_links.task_links_kind_check',
    'task_links.task_links_label_len',
    'task_links.task_links_url_check',
    'task_links.task_links_url_len',
    'task_requirements.task_requirements_kind_check',
    'task_requirements.task_requirements_label_len',
    'task_submissions.task_submissions_content_check',
    'task_submissions.task_submissions_content_text_len',
    'task_submissions.task_submissions_content_url_len',
    'task_submissions.task_submissions_verification_check',
    'task_winners.task_winners_place_check',
    'task_winners.task_winners_reward_note_len',
    'tasks.tasks_cancelled_at_check',
    'tasks.tasks_completed_at_check',
    'tasks.tasks_description_len',
    'tasks.tasks_reward_display_len',
    'tasks.tasks_reward_kind_check',
    'tasks.tasks_status_check',
    'tasks.tasks_title_check',
    'tasks.tasks_winners_count_check',
    'transfers.transfers_amount_eth_check_v2',
    'trusted_add_tickets.trusted_add_tickets_addr_format',
    'trusted_add_tickets.trusted_add_tickets_code_format',
    'trusted_addresses.trusted_addresses_addr_format',
    'trusted_addresses.trusted_addresses_status_check',
    'users.users_phone_nonempty'
  ]) as r
  where not (payload -> 'checks' ? r);

  if missing is not null then
    raise exception 'missing check constraints: %. Apply the migrations that add them, then run this again.', missing;
  end if;
end
$$;
