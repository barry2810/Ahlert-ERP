export const id = "0003_existing_schema_catalog_waste_workitem";

export async function up({ client }) {
  await client.query(`
    create table if not exists catalog_container (
      id text primary key,
      source_key text not null unique,
      group_key text not null,
      volume_cbm double precision not null,
      variant text not null,
      length_m double precision null,
      width_m double precision null,
      height_m double precision null,
      footprint_sqm double precision null,
      base_area_sqm double precision null,
      features jsonb not null default '{}'::jsonb,
      rules jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      source_url text not null,
      source_hash text not null,
      first_seen timestamptz not null default now(),
      last_seen timestamptz not null default now()
    );
  `);
  await client.query(`alter table catalog_container add column if not exists base_area_sqm double precision;`);
  await client.query(`alter table catalog_container add column if not exists features jsonb;`);
  await client.query(`alter table catalog_container add column if not exists rules jsonb;`);
  await client.query(`alter table catalog_container add column if not exists active boolean;`);
  await client.query(`update catalog_container set features = '{}'::jsonb where features is null;`);
  await client.query(`update catalog_container set rules = '{}'::jsonb where rules is null;`);
  await client.query(`update catalog_container set active = true where active is null;`);
  await client.query(`alter table catalog_container alter column features set not null;`);
  await client.query(`alter table catalog_container alter column rules set not null;`);
  await client.query(`alter table catalog_container alter column active set not null;`);
  await client.query(`create index if not exists catalog_container_group_idx on catalog_container (group_key, volume_cbm);`);

  await client.query(`
    create table if not exists catalog_service_area_zip (
      id text primary key,
      service text not null,
      zip text not null,
      active boolean not null default true,
      source_url text not null,
      source_hash text not null,
      first_seen timestamptz not null default now(),
      last_seen timestamptz not null default now(),
      unique(service, zip)
    );
  `);
  await client.query(`alter table catalog_service_area_zip add column if not exists active boolean;`);
  await client.query(`update catalog_service_area_zip set active = true where active is null;`);
  await client.query(`alter table catalog_service_area_zip alter column active set not null;`);
  await client.query(`create index if not exists catalog_service_area_zip_service_idx on catalog_service_area_zip (service, zip);`);

  await client.query(`
    create table if not exists catalog_container_event (
      id text primary key,
      run_id text not null references reconcile_run(id) on delete restrict,
      action text not null,
      source_key text not null,
      occurred_at timestamptz not null,
      details jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'catalog_container_event_action_chk'
      ) then
        alter table catalog_container_event
          add constraint catalog_container_event_action_chk check (action in ('added','updated','removed'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists catalog_container_event_run_idx on catalog_container_event (run_id, occurred_at desc);`);

  await client.query(`
    create table if not exists catalog_service_area_zip_event (
      id text primary key,
      run_id text not null references reconcile_run(id) on delete restrict,
      service text not null,
      zip text not null,
      action text not null,
      occurred_at timestamptz not null,
      details jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'catalog_service_area_zip_event_action_chk'
      ) then
        alter table catalog_service_area_zip_event
          add constraint catalog_service_area_zip_event_action_chk check (action in ('added','removed'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists catalog_service_area_zip_event_run_idx on catalog_service_area_zip_event (run_id, occurred_at desc);`);
  await client.query(`create index if not exists catalog_service_area_zip_event_service_idx on catalog_service_area_zip_event (service, occurred_at desc);`);

  await client.query(`
    create table if not exists work_item (
      id text primary key,
      kind text not null,
      item_key text not null,
      priority text not null,
      status text not null,
      title text not null,
      details jsonb not null default '{}'::jsonb,
      source_run_id text null references reconcile_run(id) on delete set null,
      created_at timestamptz not null default now(),
      closed_at timestamptz null,
      closed_by text null,
      closed_reason text null,
      unique(kind, item_key)
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'work_item_priority_chk'
      ) then
        alter table work_item
          add constraint work_item_priority_chk check (priority in ('high','medium','low'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'work_item_status_chk'
      ) then
        alter table work_item
          add constraint work_item_status_chk check (status in ('open','closed'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists work_item_status_idx on work_item (status, priority, created_at desc);`);

  await client.query(`
    create table if not exists waste_container_order (
      id text primary key,
      customer_id text null,
      customer_tier text null,
      site jsonb not null default '{}'::jsonb,
      container_source_key text not null,
      service_type text not null,
      window_deliver_start timestamptz not null,
      window_deliver_end timestamptz not null,
      window_pickup_start timestamptz null,
      window_pickup_end timestamptz null,
      context jsonb not null default '{}'::jsonb,
      status text not null,
      priority_urgency text not null default 'normal',
      priority_value double precision null,
      notes text null,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'waste_container_order_service_type_chk'
      ) then
        alter table waste_container_order
          add constraint waste_container_order_service_type_chk check (service_type in ('deliver_pickup'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'waste_container_order_priority_urgency_chk'
      ) then
        alter table waste_container_order
          add constraint waste_container_order_priority_urgency_chk check (priority_urgency in ('low','normal','high','critical'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists waste_container_order_status_idx on waste_container_order (status, created_at desc);`);
  await client.query(`create index if not exists waste_container_order_window_idx on waste_container_order (window_deliver_start, window_deliver_end);`);

  await client.query(`
    create table if not exists waste_container_order_event (
      id text primary key,
      order_id text not null references waste_container_order(id) on delete restrict,
      from_status text null,
      to_status text not null,
      reason text not null,
      username text not null,
      occurred_at timestamptz not null,
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists waste_container_order_event_order_idx on waste_container_order_event (order_id, occurred_at desc);`);

  await client.query(`
    create table if not exists waste_container_order_dispatch_check (
      id text primary key,
      order_id text not null references waste_container_order(id) on delete restrict,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      module text not null,
      window_start timestamptz not null,
      window_end timestamptz not null,
      decision jsonb not null default '{}'::jsonb,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists waste_container_order_dispatch_check_order_idx on waste_container_order_dispatch_check (order_id, created_at desc);`);

  await client.query(`
    create table if not exists waste_container_order_dispatch (
      id text primary key,
      order_id text not null references waste_container_order(id) on delete restrict,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      driver_id text null references fleet_driver(id) on delete restrict,
      module text not null,
      window_start timestamptz not null,
      window_end timestamptz not null,
      decision_snapshot jsonb not null default '{}'::jsonb,
      reason text not null,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists waste_container_order_dispatch_order_idx on waste_container_order_dispatch (order_id, created_at desc);`);

  await client.query(`
    create table if not exists waste_weigh_ticket (
      id text primary key,
      order_id text not null references waste_container_order(id) on delete restrict,
      gross_kg int not null,
      tare_kg int not null,
      net_kg int not null,
      weighed_at timestamptz not null,
      source text not null,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists waste_weigh_ticket_order_idx on waste_weigh_ticket (order_id, weighed_at desc);`);

  await client.query(`
    create table if not exists waste_invoice_draft (
      id text primary key,
      order_id text not null references waste_container_order(id) on delete restrict,
      currency text not null,
      total_cents int not null,
      lines jsonb not null default '[]'::jsonb,
      source text not null,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists waste_invoice_draft_order_idx on waste_invoice_draft (order_id, created_at desc);`);
}

