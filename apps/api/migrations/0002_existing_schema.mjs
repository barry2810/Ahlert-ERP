export const id = "0002_existing_schema";

export async function up({ client }) {
  await client.query(`
    create table if not exists reconcile_run (
      id text primary key,
      kind text not null,
      requested_by text not null,
      started_at timestamptz not null,
      finished_at timestamptz not null,
      source jsonb not null default '{}'::jsonb,
      summary jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists reconcile_run_kind_idx on reconcile_run (kind, finished_at desc);`);

  await client.query(`
    create table if not exists reconcile_finding (
      id text primary key,
      run_id text not null references reconcile_run(id) on delete restrict,
      severity text not null,
      category text not null,
      item_key text not null,
      issue text not null,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists reconcile_finding_run_idx on reconcile_finding (run_id, severity, category);`);

  await client.query(`
    create table if not exists fleet_vehicle (
      id text primary key,
      code text not null unique,
      kind text not null default 'vehicle',
      type text not null,
      attributes jsonb not null default '{}'::jsonb,
      capabilities text[] not null default '{}'::text[],
      container_sizes text[] not null default '{}'::text[],
      container_types text[] not null default '{}'::text[],
      grappler_types text[] not null default '{}'::text[],
      adr_enabled boolean not null default false,
      adr_classes text[] not null default '{}'::text[],
      home_depot text null,
      home_lat double precision null,
      home_lon double precision null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`alter table fleet_vehicle add column if not exists kind text;`);
  await client.query(`alter table fleet_vehicle add column if not exists attributes jsonb;`);
  await client.query(`update fleet_vehicle set kind = 'vehicle' where kind is null;`);
  await client.query(`update fleet_vehicle set attributes = '{}'::jsonb where attributes is null;`);
  await client.query(`alter table fleet_vehicle alter column kind set not null;`);
  await client.query(`alter table fleet_vehicle alter column attributes set not null;`);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'fleet_vehicle_kind_chk') then
        alter table fleet_vehicle add constraint fleet_vehicle_kind_chk check (kind in ('vehicle','trailer','container'));
      end if;
    end $$;
  `);
  await client.query(`alter table fleet_vehicle add column if not exists container_sizes text[];`);
  await client.query(`alter table fleet_vehicle add column if not exists container_types text[];`);
  await client.query(`alter table fleet_vehicle add column if not exists grappler_types text[];`);
  await client.query(`alter table fleet_vehicle add column if not exists adr_enabled boolean;`);
  await client.query(`alter table fleet_vehicle add column if not exists adr_classes text[];`);
  await client.query(`update fleet_vehicle set container_sizes = '{}'::text[] where container_sizes is null;`);
  await client.query(`update fleet_vehicle set container_types = '{}'::text[] where container_types is null;`);
  await client.query(`update fleet_vehicle set grappler_types = '{}'::text[] where grappler_types is null;`);
  await client.query(`update fleet_vehicle set adr_enabled = false where adr_enabled is null;`);
  await client.query(`update fleet_vehicle set adr_classes = '{}'::text[] where adr_classes is null;`);
  await client.query(`alter table fleet_vehicle alter column container_sizes set not null;`);
  await client.query(`alter table fleet_vehicle alter column container_types set not null;`);
  await client.query(`alter table fleet_vehicle alter column grappler_types set not null;`);
  await client.query(`alter table fleet_vehicle alter column adr_enabled set not null;`);
  await client.query(`alter table fleet_vehicle alter column adr_classes set not null;`);
  await client.query(`alter table fleet_vehicle add column if not exists home_depot text;`);
  await client.query(`alter table fleet_vehicle add column if not exists home_lat double precision;`);
  await client.query(`alter table fleet_vehicle add column if not exists home_lon double precision;`);
  await client.query(`create index if not exists fleet_vehicle_kind_idx on fleet_vehicle (kind, type);`);

  await client.query(`
    create table if not exists fleet_availability_block (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      source_module text not null,
      severity text not null,
      lock_type text null,
      reason text not null,
      starts_at timestamptz not null,
      ends_at timestamptz null,
      ref_entity_type text not null,
      ref_entity_id text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`alter table fleet_availability_block add column if not exists lock_type text;`);
  await client.query(`
    update fleet_availability_block
    set lock_type = case when severity = 'critical' then 'hard' else 'soft' end
    where lock_type is null;
  `);
  await client.query(`alter table fleet_availability_block alter column lock_type set not null;`);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'fleet_availability_block_lock_type_chk'
      ) then
        alter table fleet_availability_block
          add constraint fleet_availability_block_lock_type_chk check (lock_type in ('soft', 'hard'));
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists fleet_override (
      id text primary key,
      block_id text not null references fleet_availability_block(id) on delete restrict,
      username text not null,
      override_reason text not null,
      expires_at timestamptz null,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists fleet_dispatch_override (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      module text not null,
      window_start timestamptz not null,
      window_end timestamptz not null,
      decision text not null,
      reason text not null,
      username text not null,
      expires_at timestamptz null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'fleet_dispatch_override_decision_chk'
      ) then
        alter table fleet_dispatch_override
          add constraint fleet_dispatch_override_decision_chk check (decision in ('allow', 'deny'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists fleet_dispatch_override_lookup_idx on fleet_dispatch_override (vehicle_id, module, created_at desc);`);
  await client.query(`create index if not exists fleet_dispatch_override_window_idx on fleet_dispatch_override (vehicle_id, module, window_start, window_end);`);

  await client.query(`
    create table if not exists fleet_audit_log (
      id text primary key,
      event_type text not null,
      username text not null,
      occurred_at timestamptz not null default now(),
      lock_type text null,
      block_id text null,
      vehicle_id text null,
      block_reason text null,
      override_id text null,
      override_reason text null,
      meta jsonb not null default '{}'::jsonb
    );
  `);

  await client.query(`
    create table if not exists fleet_driver (
      id text primary key,
      name text not null,
      home_depot text null,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists fleet_driver_binding (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      driver_id text not null references fleet_driver(id) on delete restrict,
      binding_type text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'fleet_driver_binding_type_chk'
      ) then
        alter table fleet_driver_binding
          add constraint fleet_driver_binding_type_chk check (binding_type in ('preferred', 'exclusive'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists fleet_driver_binding_vehicle_idx on fleet_driver_binding (vehicle_id, active, created_at desc);`);
  await client.query(`create index if not exists fleet_driver_binding_driver_idx on fleet_driver_binding (driver_id, active, created_at desc);`);

  await client.query(`
    create table if not exists fleet_vehicle_system_status (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      system text not null,
      status text not null,
      source text null,
      updated_at timestamptz not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'fleet_vehicle_system_status_system_chk'
      ) then
        alter table fleet_vehicle_system_status
          add constraint fleet_vehicle_system_status_system_chk check (system in ('tank', 'weigh'));
      end if;
      if not exists (
        select 1 from pg_constraint where conname = 'fleet_vehicle_system_status_status_chk'
      ) then
        alter table fleet_vehicle_system_status
          add constraint fleet_vehicle_system_status_status_chk check (status in ('ok', 'down', 'unknown'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists fleet_vehicle_system_status_lookup_idx on fleet_vehicle_system_status (vehicle_id, system, updated_at desc);`);

  await client.query(`
    create table if not exists fleet_depot (
      code text primary key,
      name text null,
      lat double precision null,
      lon double precision null,
      utilization double precision not null default 0.0,
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'fleet_depot_utilization_chk'
      ) then
        alter table fleet_depot
          add constraint fleet_depot_utilization_chk check (utilization >= 0 and utilization <= 1);
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists fleet_dispatch_assignment (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      driver_id text null references fleet_driver(id) on delete restrict,
      module text not null,
      window_start timestamptz not null,
      window_end timestamptz not null,
      order_id text null,
      route_id text null,
      priority_score int not null default 0,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists fleet_dispatch_assignment_vehicle_idx on fleet_dispatch_assignment (vehicle_id, window_start, window_end);`);
  await client.query(`create index if not exists fleet_dispatch_assignment_driver_idx on fleet_dispatch_assignment (driver_id, window_start, window_end);`);

  await client.query(`
    create table if not exists fleet_unit_coupling (
      id text primary key,
      primary_unit_id text not null references fleet_vehicle(id) on delete restrict,
      secondary_unit_id text not null references fleet_vehicle(id) on delete restrict,
      starts_at timestamptz not null,
      ends_at timestamptz null,
      created_by text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists fleet_unit_coupling_primary_idx on fleet_unit_coupling (primary_unit_id, starts_at desc);`);
  await client.query(`create index if not exists fleet_unit_coupling_secondary_idx on fleet_unit_coupling (secondary_unit_id, starts_at desc);`);

  await client.query(`
    create table if not exists fleet_unit_location (
      id text primary key,
      unit_id text not null references fleet_vehicle(id) on delete restrict,
      location_type text not null,
      location_code text null,
      lat double precision null,
      lon double precision null,
      recorded_at timestamptz not null,
      source text not null,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'fleet_unit_location_location_type_chk') then
        alter table fleet_unit_location add constraint fleet_unit_location_location_type_chk check (location_type in ('workshop','yard','external','unknown'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists fleet_unit_location_unit_idx on fleet_unit_location (unit_id, recorded_at desc);`);

  await client.query(`
    create table if not exists fleet_inspection (
      id text primary key,
      unit_id text not null references fleet_vehicle(id) on delete restrict,
      inspection_type text not null,
      due_month text not null,
      due_from date not null,
      due_to date not null,
      status text not null,
      completed_at timestamptz null,
      completed_by text null,
      report_pdf jsonb null,
      created_by text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'fleet_inspection_status_chk') then
        alter table fleet_inspection add constraint fleet_inspection_status_chk check (status in ('scheduled','completed'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists fleet_inspection_unit_idx on fleet_inspection (unit_id, due_to desc);`);
  await client.query(`create index if not exists fleet_inspection_due_idx on fleet_inspection (status, due_from, due_to);`);
}
