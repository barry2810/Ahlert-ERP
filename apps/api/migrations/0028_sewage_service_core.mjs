export const id = "0028_sewage_service_core";

export async function up({ client }) {
  await client.query(`
    create table if not exists sewage_asset (
      id text primary key,
      asset_no text not null unique,
      asset_type text not null,
      name text null,
      municipality_id text null references waste_municipality(id) on delete set null,
      status text not null default 'active',
      geo_point jsonb not null default '{}'::jsonb,
      geo_line jsonb not null default '{}'::jsonb,
      meta jsonb not null default '{}'::jsonb,
      created_by text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists sewage_order (
      id text primary key,
      order_no text not null unique,
      order_type text not null,
      status text not null default 'requested',
      priority text not null default 'normal',
      customer_id text not null references crm_customer(id) on delete restrict,
      contract_id text null references crm_contract(id) on delete set null,
      municipality_id text null references waste_municipality(id) on delete set null,
      title text not null,
      description text null,
      requested_at timestamptz not null default now(),
      planned_start timestamptz null,
      planned_end timestamptz null,
      required_by timestamptz null,
      is_emergency boolean not null default false,
      geo_point jsonb not null default '{}'::jsonb,
      geo_address text null,
      meta jsonb not null default '{}'::jsonb,
      created_by text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists sewage_order_asset (
      id text primary key,
      order_id text not null references sewage_order(id) on delete cascade,
      asset_id text not null references sewage_asset(id) on delete restrict,
      role text not null default 'affected',
      created_at timestamptz not null default now(),
      unique (order_id, asset_id, role)
    );
  `);

  await client.query(`
    create table if not exists sewage_execution (
      id text primary key,
      order_id text not null references sewage_order(id) on delete cascade,
      status text not null default 'started',
      crew_name text null,
      vehicle_id text null,
      started_at timestamptz null,
      finished_at timestamptz null,
      offline_capture boolean not null default false,
      sync_state text not null default 'pending',
      notes text null,
      meta jsonb not null default '{}'::jsonb,
      created_by text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists sewage_finding (
      id text primary key,
      order_id text not null references sewage_order(id) on delete cascade,
      execution_id text null references sewage_execution(id) on delete set null,
      asset_id text null references sewage_asset(id) on delete set null,
      code text null,
      severity text not null default 'medium',
      status text not null default 'captured',
      description text null,
      recommended_action text null,
      requires_followup boolean not null default false,
      meta jsonb not null default '{}'::jsonb,
      created_by text null,
      validated_by text null,
      validated_at timestamptz null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists sewage_media_link (
      id text primary key,
      document_id text not null references doc_document(id) on delete cascade,
      order_id text not null references sewage_order(id) on delete cascade,
      execution_id text null references sewage_execution(id) on delete set null,
      asset_id text null references sewage_asset(id) on delete set null,
      finding_id text null references sewage_finding(id) on delete set null,
      media_role text not null default 'photo',
      captured_at timestamptz null,
      captured_by text null,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists sewage_billing_case (
      id text primary key,
      order_id text not null unique references sewage_order(id) on delete cascade,
      contract_id text null references crm_contract(id) on delete set null,
      waste_invoice_draft_id text null references waste_invoice_draft(id) on delete set null,
      status text not null default 'collecting',
      pricing_snapshot jsonb not null default '{}'::jsonb,
      blocked_reason text null,
      created_by text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'sewage_asset_type_chk') then
        alter table sewage_asset add constraint sewage_asset_type_chk
          check (asset_type in ('haltung','schacht','hausanschluss','sonderbauwerk','abschnitt','zone'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_asset_status_chk') then
        alter table sewage_asset add constraint sewage_asset_status_chk
          check (status in ('active','inactive','archived'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_order_type_chk') then
        alter table sewage_order add constraint sewage_order_type_chk
          check (order_type in ('kanalreinigung','spuelung','tv_inspektion','dichtheitspruefung','notdienst','fraes_sonderarbeiten','sanierungsvorbereitung','nachkontrolle'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_order_status_chk') then
        alter table sewage_order add constraint sewage_order_status_chk
          check (status in ('requested','planned','dispatched','in_progress','completed','approved','closed','cancelled'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_order_priority_chk') then
        alter table sewage_order add constraint sewage_order_priority_chk
          check (priority in ('low','normal','high','critical'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_order_asset_role_chk') then
        alter table sewage_order_asset add constraint sewage_order_asset_role_chk
          check (role in ('primary','affected','inspection_target','followup_target'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_execution_status_chk') then
        alter table sewage_execution add constraint sewage_execution_status_chk
          check (status in ('started','paused','finished','approved'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_execution_sync_state_chk') then
        alter table sewage_execution add constraint sewage_execution_sync_state_chk
          check (sync_state in ('pending','partial','synced','conflict'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_finding_severity_chk') then
        alter table sewage_finding add constraint sewage_finding_severity_chk
          check (severity in ('low','medium','high','critical'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_finding_status_chk') then
        alter table sewage_finding add constraint sewage_finding_status_chk
          check (status in ('captured','validated','action_required','resolved'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_media_link_role_chk') then
        alter table sewage_media_link add constraint sewage_media_link_role_chk
          check (media_role in ('photo','video','scan','protocol_attachment','signature'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'sewage_billing_case_status_chk') then
        alter table sewage_billing_case add constraint sewage_billing_case_status_chk
          check (status in ('collecting','ready','blocked','transferred'));
      end if;
    end $$;
  `);

  await client.query(`create index if not exists sewage_asset_type_idx on sewage_asset (asset_type, status, updated_at desc);`);
  await client.query(`create index if not exists sewage_order_status_idx on sewage_order (status, priority, created_at desc);`);
  await client.query(`create index if not exists sewage_order_customer_idx on sewage_order (customer_id, created_at desc);`);
  await client.query(`create index if not exists sewage_execution_order_idx on sewage_execution (order_id, status, created_at desc);`);
  await client.query(`create index if not exists sewage_finding_order_idx on sewage_finding (order_id, status, severity, created_at desc);`);
  await client.query(`create index if not exists sewage_media_link_order_idx on sewage_media_link (order_id, media_role, created_at desc);`);
  await client.query(`create index if not exists sewage_billing_case_status_idx on sewage_billing_case (status, updated_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists sewage_billing_case;`);
  await client.query(`drop table if exists sewage_media_link;`);
  await client.query(`drop table if exists sewage_finding;`);
  await client.query(`drop table if exists sewage_execution;`);
  await client.query(`drop table if exists sewage_order_asset;`);
  await client.query(`drop table if exists sewage_order;`);
  await client.query(`drop table if exists sewage_asset;`);
}