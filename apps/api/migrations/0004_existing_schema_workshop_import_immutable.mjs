export const id = "0004_existing_schema_workshop_import_immutable";

export async function up({ client }) {
  await client.query(`
    create table if not exists workshop_case (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      title text not null,
      description text null,
      priority text not null default 'medium',
      reporter_role text not null default 'workshop',
      work_state text not null default 'created',
      interrupted boolean not null default false,
      delivery_delay boolean not null default false,
      assigned_to text null,
      assigned_by text null,
      assigned_at timestamptz null,
      photo jsonb null,
      severity text not null,
      lock_type text not null,
      status text not null,
      opened_at timestamptz not null,
      closed_at timestamptz null,
      closed_reason text null,
      created_by text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`alter table workshop_case add column if not exists priority text;`);
  await client.query(`alter table workshop_case add column if not exists reporter_role text;`);
  await client.query(`alter table workshop_case add column if not exists work_state text;`);
  await client.query(`alter table workshop_case add column if not exists interrupted boolean;`);
  await client.query(`alter table workshop_case add column if not exists delivery_delay boolean;`);
  await client.query(`alter table workshop_case add column if not exists assigned_to text;`);
  await client.query(`alter table workshop_case add column if not exists assigned_by text;`);
  await client.query(`alter table workshop_case add column if not exists assigned_at timestamptz;`);
  await client.query(`alter table workshop_case add column if not exists photo jsonb;`);
  await client.query(`update workshop_case set priority = 'medium' where priority is null;`);
  await client.query(`update workshop_case set reporter_role = 'workshop' where reporter_role is null;`);
  await client.query(`update workshop_case set work_state = 'created' where work_state is null;`);
  await client.query(`update workshop_case set interrupted = false where interrupted is null;`);
  await client.query(`update workshop_case set delivery_delay = false where delivery_delay is null;`);
  await client.query(`alter table workshop_case alter column priority set not null;`);
  await client.query(`alter table workshop_case alter column reporter_role set not null;`);
  await client.query(`alter table workshop_case alter column work_state set not null;`);
  await client.query(`alter table workshop_case alter column interrupted set not null;`);
  await client.query(`alter table workshop_case alter column delivery_delay set not null;`);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'workshop_case_severity_chk') then
        alter table workshop_case add constraint workshop_case_severity_chk check (severity in ('critical','warning','info'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'workshop_case_lock_type_chk') then
        alter table workshop_case add constraint workshop_case_lock_type_chk check (lock_type in ('soft','hard'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'workshop_case_priority_chk') then
        alter table workshop_case add constraint workshop_case_priority_chk check (priority in ('low','medium','high'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'workshop_case_reporter_role_chk') then
        alter table workshop_case add constraint workshop_case_reporter_role_chk check (reporter_role in ('driver','workshop'));
      end if;
      if exists (select 1 from pg_constraint where conname = 'workshop_case_work_state_chk') then
        alter table workshop_case drop constraint workshop_case_work_state_chk;
      end if;
      alter table workshop_case add constraint workshop_case_work_state_chk check (work_state in ('created','assigned','in_progress','waiting_parts','done'));
      if not exists (select 1 from pg_constraint where conname = 'workshop_case_status_chk') then
        alter table workshop_case add constraint workshop_case_status_chk check (status in ('open','closed'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists workshop_case_vehicle_idx on workshop_case (vehicle_id, status, opened_at desc);`);
  await client.query(`create index if not exists workshop_case_pool_idx on workshop_case (status, priority, opened_at desc);`);
  await client.query(`create index if not exists workshop_case_assignee_idx on workshop_case (assigned_to, status, opened_at desc);`);
  await client.query(`create index if not exists workshop_case_work_state_idx on workshop_case (work_state, status, opened_at desc);`);

  await client.query(`
    create table if not exists workshop_case_event (
      id text primary key,
      case_id text not null references workshop_case(id) on delete restrict,
      from_status text null,
      to_status text not null,
      reason text not null,
      username text not null,
      occurred_at timestamptz not null,
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists workshop_case_event_case_idx on workshop_case_event (case_id, occurred_at desc);`);

  await client.query(`
    create table if not exists workshop_case_message (
      id text primary key,
      case_id text not null references workshop_case(id) on delete restrict,
      message text not null,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists workshop_case_message_case_idx on workshop_case_message (case_id, created_at desc);`);

  await client.query(`
    create table if not exists workshop_case_approval (
      id text primary key,
      case_id text not null references workshop_case(id) on delete restrict,
      requested_by text not null,
      requested_at timestamptz not null,
      status text not null,
      decided_by text null,
      decided_at timestamptz null,
      decision text null,
      note text null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'workshop_case_approval_status_chk') then
        alter table workshop_case_approval add constraint workshop_case_approval_status_chk check (status in ('requested','decided'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'workshop_case_approval_decision_chk') then
        alter table workshop_case_approval add constraint workshop_case_approval_decision_chk check (decision is null or decision in ('approved','rejected'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists workshop_case_approval_case_idx on workshop_case_approval (case_id, requested_at desc);`);

  await client.query(`
    create table if not exists workshop_case_signature (
      id text primary key,
      case_id text not null references workshop_case(id) on delete restrict,
      signed_by text not null,
      signed_at timestamptz not null,
      signature jsonb not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists workshop_case_signature_case_idx on workshop_case_signature (case_id, signed_at desc);`);

  await client.query(`
    create table if not exists workshop_vehicle_meter (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      km int null,
      engine_hours double precision null,
      recorded_at timestamptz not null,
      source text not null,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists workshop_vehicle_meter_vehicle_idx on workshop_vehicle_meter (vehicle_id, recorded_at desc);`);

  await client.query(`
    create table if not exists workshop_vehicle_service (
      id text primary key,
      vehicle_id text not null references fleet_vehicle(id) on delete restrict,
      service_code text not null,
      km int null,
      engine_hours double precision null,
      serviced_at timestamptz not null,
      username text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists workshop_vehicle_service_vehicle_idx on workshop_vehicle_service (vehicle_id, service_code, serviced_at desc);`);

  await client.query(`
    create table if not exists workshop_maintenance_rule (
      id text primary key,
      vehicle_type text not null,
      service_code text not null,
      km_interval int null,
      days_interval int null,
      hours_interval double precision null,
      active boolean not null default true,
      updated_at timestamptz not null default now(),
      unique(vehicle_type, service_code)
    );
  `);
  await client.query(`create index if not exists workshop_maintenance_rule_type_idx on workshop_maintenance_rule (vehicle_type, active);`);

  await client.query(`
    create table if not exists workshop_slot_plan (
      id text primary key,
      day date not null,
      slot_index int not null,
      assignee text not null,
      case_id text null references workshop_case(id) on delete set null,
      notes text null,
      updated_by text not null,
      updated_at timestamptz not null default now(),
      unique(day, slot_index, assignee)
    );
  `);
  await client.query(`create index if not exists workshop_slot_plan_day_idx on workshop_slot_plan (day, assignee, slot_index);`);

  await client.query(`
    create table if not exists workshop_inventory_supplier (
      id text primary key,
      name text not null,
      contact jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists workshop_inventory_location (
      id text primary key,
      code text not null unique,
      description text null,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists workshop_inventory_item (
      id text primary key,
      part_no text not null unique,
      description text not null,
      supplier_id text null references workshop_inventory_supplier(id) on delete set null,
      qr_code text not null unique,
      min_qty int not null default 0,
      active boolean not null default true,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists workshop_inventory_stock (
      id text primary key,
      item_id text not null references workshop_inventory_item(id) on delete restrict,
      location_id text not null references workshop_inventory_location(id) on delete restrict,
      qty int not null default 0,
      updated_at timestamptz not null default now(),
      unique(item_id, location_id)
    );
  `);
  await client.query(`create index if not exists workshop_inventory_stock_item_idx on workshop_inventory_stock (item_id, qty desc);`);

  await client.query(`
    create table if not exists workshop_inventory_movement (
      id text primary key,
      movement_type text not null,
      item_id text not null references workshop_inventory_item(id) on delete restrict,
      qty int not null,
      from_location_id text null references workshop_inventory_location(id) on delete restrict,
      to_location_id text null references workshop_inventory_location(id) on delete restrict,
      unit_id text null references fleet_vehicle(id) on delete restrict,
      case_id text null references workshop_case(id) on delete set null,
      identifiers jsonb not null default '{}'::jsonb,
      reason text not null,
      username text not null,
      occurred_at timestamptz not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'workshop_inventory_movement_type_chk') then
        alter table workshop_inventory_movement
          add constraint workshop_inventory_movement_type_chk check (movement_type in ('inbound','putaway','pickup','issue','transfer','adjust'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists workshop_inventory_movement_item_idx on workshop_inventory_movement (item_id, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_unit_idx on workshop_inventory_movement (unit_id, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_identifiers_gin on workshop_inventory_movement using gin (identifiers);`);

  await client.query(`
    create table if not exists import_run (
      id text primary key,
      kind text not null,
      source_path text not null,
      status text not null,
      started_at timestamptz not null,
      finished_at timestamptz not null,
      requested_by text not null,
      summary jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists import_run_kind_idx on import_run (kind, finished_at desc);`);

  await client.query(`
    create table if not exists import_issue (
      id text primary key,
      run_id text not null references import_run(id) on delete restrict,
      severity text not null,
      table_name text null,
      pk text null,
      column_name text null,
      entity_type text null,
      entity_key text null,
      message text not null,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists import_issue_run_idx on import_issue (run_id, severity, created_at desc);`);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_proc where proname = 'deny_audit_modification') then
        create function deny_audit_modification() returns trigger as $f$
        begin
          raise exception 'audit_log_is_immutable';
        end;
        $f$ language plpgsql;
      end if;
    end $$;
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_trigger where tgname = 'reconcile_run_no_update') then
        create trigger reconcile_run_no_update
        before update on reconcile_run
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'reconcile_run_no_delete') then
        create trigger reconcile_run_no_delete
        before delete on reconcile_run
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'reconcile_finding_no_update') then
        create trigger reconcile_finding_no_update
        before update on reconcile_finding
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'reconcile_finding_no_delete') then
        create trigger reconcile_finding_no_delete
        before delete on reconcile_finding
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'import_run_no_update') then
        create trigger import_run_no_update
        before update on import_run
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'import_run_no_delete') then
        create trigger import_run_no_delete
        before delete on import_run
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'import_issue_no_update') then
        create trigger import_issue_no_update
        before update on import_issue
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'import_issue_no_delete') then
        create trigger import_issue_no_delete
        before delete on import_issue
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'catalog_container_event_no_update') then
        create trigger catalog_container_event_no_update
        before update on catalog_container_event
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'catalog_container_event_no_delete') then
        create trigger catalog_container_event_no_delete
        before delete on catalog_container_event
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'catalog_service_area_zip_event_no_update') then
        create trigger catalog_service_area_zip_event_no_update
        before update on catalog_service_area_zip_event
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'catalog_service_area_zip_event_no_delete') then
        create trigger catalog_service_area_zip_event_no_delete
        before delete on catalog_service_area_zip_event
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'waste_container_order_event_no_update') then
        create trigger waste_container_order_event_no_update
        before update on waste_container_order_event
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'waste_container_order_event_no_delete') then
        create trigger waste_container_order_event_no_delete
        before delete on waste_container_order_event
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'waste_container_order_dispatch_check_no_update') then
        create trigger waste_container_order_dispatch_check_no_update
        before update on waste_container_order_dispatch_check
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'waste_container_order_dispatch_check_no_delete') then
        create trigger waste_container_order_dispatch_check_no_delete
        before delete on waste_container_order_dispatch_check
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'waste_container_order_dispatch_no_update') then
        create trigger waste_container_order_dispatch_no_update
        before update on waste_container_order_dispatch
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'waste_container_order_dispatch_no_delete') then
        create trigger waste_container_order_dispatch_no_delete
        before delete on waste_container_order_dispatch
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'waste_weigh_ticket_no_update') then
        create trigger waste_weigh_ticket_no_update
        before update on waste_weigh_ticket
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'waste_weigh_ticket_no_delete') then
        create trigger waste_weigh_ticket_no_delete
        before delete on waste_weigh_ticket
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'waste_invoice_draft_no_update') then
        create trigger waste_invoice_draft_no_update
        before update on waste_invoice_draft
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'waste_invoice_draft_no_delete') then
        create trigger waste_invoice_draft_no_delete
        before delete on waste_invoice_draft
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_event_no_update') then
        create trigger workshop_case_event_no_update
        before update on workshop_case_event
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_event_no_delete') then
        create trigger workshop_case_event_no_delete
        before delete on workshop_case_event
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_message_no_update') then
        create trigger workshop_case_message_no_update
        before update on workshop_case_message
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_message_no_delete') then
        create trigger workshop_case_message_no_delete
        before delete on workshop_case_message
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_approval_no_update') then
        create trigger workshop_case_approval_no_update
        before update on workshop_case_approval
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_approval_no_delete') then
        create trigger workshop_case_approval_no_delete
        before delete on workshop_case_approval
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_signature_no_update') then
        create trigger workshop_case_signature_no_update
        before update on workshop_case_signature
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'workshop_case_signature_no_delete') then
        create trigger workshop_case_signature_no_delete
        before delete on workshop_case_signature
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'workshop_vehicle_meter_no_update') then
        create trigger workshop_vehicle_meter_no_update
        before update on workshop_vehicle_meter
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'workshop_vehicle_meter_no_delete') then
        create trigger workshop_vehicle_meter_no_delete
        before delete on workshop_vehicle_meter
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'workshop_vehicle_service_no_update') then
        create trigger workshop_vehicle_service_no_update
        before update on workshop_vehicle_service
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'workshop_vehicle_service_no_delete') then
        create trigger workshop_vehicle_service_no_delete
        before delete on workshop_vehicle_service
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'fleet_unit_location_no_update') then
        create trigger fleet_unit_location_no_update
        before update on fleet_unit_location
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'fleet_unit_location_no_delete') then
        create trigger fleet_unit_location_no_delete
        before delete on fleet_unit_location
        for each row execute function deny_audit_modification();
      end if;

      if not exists (select 1 from pg_trigger where tgname = 'workshop_inventory_movement_no_update') then
        create trigger workshop_inventory_movement_no_update
        before update on workshop_inventory_movement
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'workshop_inventory_movement_no_delete') then
        create trigger workshop_inventory_movement_no_delete
        before delete on workshop_inventory_movement
        for each row execute function deny_audit_modification();
      end if;
    end $$;
  `);

  await client.query(`
    do $$
    begin
      if not exists (
        select 1
        from pg_trigger
        where tgname = 'fleet_audit_log_no_update'
      ) then
        create trigger fleet_audit_log_no_update
        before update on fleet_audit_log
        for each row execute function deny_audit_modification();
      end if;

      if not exists (
        select 1
        from pg_trigger
        where tgname = 'fleet_audit_log_no_delete'
      ) then
        create trigger fleet_audit_log_no_delete
        before delete on fleet_audit_log
        for each row execute function deny_audit_modification();
      end if;
    end $$;
  `);
}

