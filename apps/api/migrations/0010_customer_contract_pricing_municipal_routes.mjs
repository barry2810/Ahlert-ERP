export const id = "0010_customer_contract_pricing_municipal_routes";

export async function up({ client }) {
  await client.query(`
    create table if not exists crm_customer (
      id text primary key,
      customer_no text not null unique,
      name text not null,
      legal_form text null,
      vat_id text null,
      billing_address jsonb not null default '{}'::jsonb,
      service_addresses jsonb not null default '[]'::jsonb,
      email text null,
      phone text null,
      payment_terms jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists crm_customer_active_name_idx on crm_customer (active, name);`);
  await client.query(`create index if not exists crm_customer_updated_idx on crm_customer (updated_at desc);`);

  await client.query(`
    create table if not exists crm_contact (
      id text primary key,
      customer_id text not null references crm_customer(id) on delete restrict,
      name text not null,
      role text null,
      email text null,
      phone text null,
      notes text null,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists crm_contact_customer_active_idx on crm_contact (customer_id, active, updated_at desc);`);

  await client.query(`
    create table if not exists crm_contract (
      id text primary key,
      contract_no text not null unique,
      customer_id text not null references crm_customer(id) on delete restrict,
      status text not null,
      valid_from date not null,
      valid_to date null,
      title text null,
      terms jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'crm_contract_status_chk') then
        alter table crm_contract add constraint crm_contract_status_chk check (status in ('draft','active','terminated'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'crm_contract_valid_range_chk') then
        alter table crm_contract add constraint crm_contract_valid_range_chk check (valid_to is null or valid_to >= valid_from);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists crm_contract_customer_status_idx on crm_contract (customer_id, status, valid_from desc);`);
  await client.query(`create index if not exists crm_contract_valid_idx on crm_contract (status, valid_from, valid_to);`);

  await client.query(`
    create table if not exists item_material (
      id text primary key,
      code text not null unique,
      name text not null,
      unit text not null default 't',
      hazard_class text null,
      active boolean not null default true,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'item_material_unit_chk') then
        alter table item_material add constraint item_material_unit_chk check (unit in ('t','kg','cbm','piece'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists item_material_active_name_idx on item_material (active, name);`);

  await client.query(`
    create table if not exists item_service (
      id text primary key,
      code text not null unique,
      name text not null,
      unit text not null default 'order',
      active boolean not null default true,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'item_service_unit_chk') then
        alter table item_service add constraint item_service_unit_chk check (unit in ('order','t','kg','cbm','piece'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists item_service_active_name_idx on item_service (active, name);`);

  await client.query(`
    create table if not exists pricing_price_list (
      id text primary key,
      code text not null unique,
      name text not null,
      currency text not null default 'EUR',
      valid_from date not null,
      valid_to date null,
      status text not null,
      scope jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'pricing_price_list_status_chk') then
        alter table pricing_price_list add constraint pricing_price_list_status_chk check (status in ('draft','active','archived'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_price_list_currency_chk') then
        alter table pricing_price_list add constraint pricing_price_list_currency_chk check (currency ~ '^[A-Z]{3}$');
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_price_list_valid_range_chk') then
        alter table pricing_price_list add constraint pricing_price_list_valid_range_chk check (valid_to is null or valid_to >= valid_from);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists pricing_price_list_status_valid_idx on pricing_price_list (status, valid_from desc);`);

  await client.query(`
    create table if not exists pricing_price_list_item (
      id text primary key,
      price_list_id text not null references pricing_price_list(id) on delete restrict,
      item_type text not null,
      ref_code text not null,
      unit text not null,
      min_qty numeric not null default 0,
      max_qty numeric null,
      unit_price_cents int not null,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      unique(price_list_id, item_type, ref_code, min_qty)
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'pricing_price_list_item_type_chk') then
        alter table pricing_price_list_item add constraint pricing_price_list_item_type_chk check (item_type in ('service','material','fee'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_price_list_item_unit_chk') then
        alter table pricing_price_list_item add constraint pricing_price_list_item_unit_chk check (unit in ('order','t','kg','cbm','piece'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_price_list_item_qty_chk') then
        alter table pricing_price_list_item add constraint pricing_price_list_item_qty_chk check (min_qty >= 0 and (max_qty is null or max_qty > min_qty));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_price_list_item_price_chk') then
        alter table pricing_price_list_item add constraint pricing_price_list_item_price_chk check (unit_price_cents >= 0);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists pricing_price_list_item_lookup_idx on pricing_price_list_item (price_list_id, item_type, ref_code, min_qty desc);`);

  await client.query(`
    create table if not exists pricing_customer_override (
      id text primary key,
      customer_id text not null references crm_customer(id) on delete restrict,
      contract_id text null references crm_contract(id) on delete restrict,
      item_type text not null,
      ref_code text not null,
      currency text not null default 'EUR',
      valid_from date not null,
      valid_to date null,
      override_mode text not null,
      value_cents int null,
      value_pct numeric null,
      min_qty numeric not null default 0,
      max_qty numeric null,
      created_by text not null,
      created_at timestamptz not null default now(),
      unique(customer_id, contract_id, item_type, ref_code, valid_from, min_qty)
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'pricing_customer_override_type_chk') then
        alter table pricing_customer_override add constraint pricing_customer_override_type_chk check (item_type in ('service','material','fee'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_customer_override_currency_chk') then
        alter table pricing_customer_override add constraint pricing_customer_override_currency_chk check (currency ~ '^[A-Z]{3}$');
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_customer_override_valid_range_chk') then
        alter table pricing_customer_override add constraint pricing_customer_override_valid_range_chk check (valid_to is null or valid_to >= valid_from);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_customer_override_mode_chk') then
        alter table pricing_customer_override add constraint pricing_customer_override_mode_chk check (override_mode in ('replace','discount_pct','discount_cents'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_customer_override_qty_chk') then
        alter table pricing_customer_override add constraint pricing_customer_override_qty_chk check (min_qty >= 0 and (max_qty is null or max_qty > min_qty));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_customer_override_value_chk') then
        alter table pricing_customer_override add constraint pricing_customer_override_value_chk check (
          (override_mode = 'replace' and value_cents is not null and value_cents >= 0 and value_pct is null)
          or (override_mode = 'discount_cents' and value_cents is not null and value_cents >= 0 and value_pct is null)
          or (override_mode = 'discount_pct' and value_pct is not null and value_pct >= 0 and value_pct <= 100 and value_cents is null)
        );
      end if;
    end $$;
  `);
  await client.query(`create index if not exists pricing_customer_override_lookup_idx on pricing_customer_override (customer_id, contract_id, item_type, ref_code, valid_from desc, min_qty desc);`);

  await client.query(`
    create table if not exists pricing_fee (
      id text primary key,
      code text not null unique,
      name text not null,
      calculation_mode text not null,
      amount_cents int not null,
      currency text not null default 'EUR',
      valid_from date not null,
      valid_to date null,
      active boolean not null default true,
      meta jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'pricing_fee_mode_chk') then
        alter table pricing_fee add constraint pricing_fee_mode_chk check (calculation_mode in ('per_order','per_ton','per_container'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_fee_currency_chk') then
        alter table pricing_fee add constraint pricing_fee_currency_chk check (currency ~ '^[A-Z]{3}$');
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_fee_valid_range_chk') then
        alter table pricing_fee add constraint pricing_fee_valid_range_chk check (valid_to is null or valid_to >= valid_from);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'pricing_fee_amount_chk') then
        alter table pricing_fee add constraint pricing_fee_amount_chk check (amount_cents >= 0);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists pricing_fee_active_valid_idx on pricing_fee (active, valid_from desc);`);

  await client.query(`
    create table if not exists pricing_calculation (
      id text primary key,
      order_id text not null references waste_container_order(id) on delete restrict,
      customer_id text null references crm_customer(id) on delete restrict,
      contract_id text null references crm_contract(id) on delete restrict,
      calculated_at timestamptz not null,
      currency text not null default 'EUR',
      total_cents int not null,
      algorithm_version text not null,
      input jsonb not null default '{}'::jsonb,
      output jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists pricing_calculation_order_idx on pricing_calculation (order_id, calculated_at desc);`);
  await client.query(`create index if not exists pricing_calculation_customer_idx on pricing_calculation (customer_id, calculated_at desc);`);

  await client.query(`
    create table if not exists pricing_calculation_event (
      id text primary key,
      calculation_id text not null references pricing_calculation(id) on delete restrict,
      event_type text not null,
      username text not null,
      occurred_at timestamptz not null,
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'pricing_calculation_event_type_chk') then
        alter table pricing_calculation_event add constraint pricing_calculation_event_type_chk check (event_type in ('calculated','recalculated','voided'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists pricing_calculation_event_calc_idx on pricing_calculation_event (calculation_id, occurred_at desc);`);

  await client.query(`
    create table if not exists waste_municipality (
      id text primary key,
      code text not null unique,
      name text not null,
      state text null,
      rules jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists waste_municipality_active_name_idx on waste_municipality (active, name);`);

  await client.query(`
    create table if not exists waste_disposal_site (
      id text primary key,
      municipality_id text not null references waste_municipality(id) on delete restrict,
      code text not null unique,
      name text not null,
      lat double precision null,
      lon double precision null,
      address text null,
      accepted_material_codes text[] not null default '{}'::text[],
      operating_hours jsonb not null default '{}'::jsonb,
      legal jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists waste_disposal_site_muni_active_idx on waste_disposal_site (municipality_id, active, code);`);

  await client.query(`alter table waste_container_order add column if not exists customer_ref_id text;`);
  await client.query(`alter table waste_container_order add column if not exists contract_id text;`);
  await client.query(`alter table waste_container_order add column if not exists municipality_id text;`);
  await client.query(`alter table waste_container_order add column if not exists disposal_site_id text;`);
  await client.query(`alter table waste_container_order add column if not exists material_code text;`);
  await client.query(`alter table waste_container_order add column if not exists planned_tons numeric;`);
  await client.query(`alter table waste_container_order add column if not exists planned_volume_cbm numeric;`);
  await client.query(`alter table waste_container_order add column if not exists legal jsonb;`);
  await client.query(`update waste_container_order set legal = '{}'::jsonb where legal is null;`);
  await client.query(`alter table waste_container_order alter column legal set not null;`);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'waste_container_order_customer_fk') then
        alter table waste_container_order add constraint waste_container_order_customer_fk
          foreign key (customer_ref_id) references crm_customer(id) on delete restrict;
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_container_order_contract_fk') then
        alter table waste_container_order add constraint waste_container_order_contract_fk
          foreign key (contract_id) references crm_contract(id) on delete restrict;
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_container_order_muni_fk') then
        alter table waste_container_order add constraint waste_container_order_muni_fk
          foreign key (municipality_id) references waste_municipality(id) on delete restrict;
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_container_order_site_fk') then
        alter table waste_container_order add constraint waste_container_order_site_fk
          foreign key (disposal_site_id) references waste_disposal_site(id) on delete restrict;
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_container_order_planned_tons_chk') then
        alter table waste_container_order add constraint waste_container_order_planned_tons_chk check (planned_tons is null or planned_tons >= 0);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_container_order_planned_volume_chk') then
        alter table waste_container_order add constraint waste_container_order_planned_volume_chk check (planned_volume_cbm is null or planned_volume_cbm >= 0);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists waste_container_order_customer_ref_idx on waste_container_order (customer_ref_id, created_at desc);`);
  await client.query(`create index if not exists waste_container_order_muni_idx on waste_container_order (municipality_id, created_at desc);`);

  await client.query(`alter table fleet_vehicle add column if not exists payload_max_kg int;`);
  await client.query(`alter table fleet_vehicle add column if not exists volume_max_cbm numeric;`);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'fleet_vehicle_payload_max_chk') then
        alter table fleet_vehicle add constraint fleet_vehicle_payload_max_chk check (payload_max_kg is null or payload_max_kg > 0);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'fleet_vehicle_volume_max_chk') then
        alter table fleet_vehicle add constraint fleet_vehicle_volume_max_chk check (volume_max_cbm is null or volume_max_cbm > 0);
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists waste_route (
      id text primary key,
      day date not null,
      depot_code text null,
      municipality_id text null references waste_municipality(id) on delete restrict,
      disposal_site_id text null references waste_disposal_site(id) on delete restrict,
      status text not null,
      vehicle_id text null references fleet_vehicle(id) on delete restrict,
      driver_id text null references fleet_driver(id) on delete restrict,
      planned_start_at timestamptz null,
      planned_end_at timestamptz null,
      capacity_max_kg int null,
      capacity_max_cbm numeric null,
      meta jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'waste_route_status_chk') then
        alter table waste_route add constraint waste_route_status_chk check (status in ('planned','in_progress','completed','cancelled'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_route_capacity_max_chk') then
        alter table waste_route add constraint waste_route_capacity_max_chk check (capacity_max_kg is null or capacity_max_kg > 0);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists waste_route_day_status_idx on waste_route (day, status, updated_at desc);`);
  await client.query(`create index if not exists waste_route_vehicle_day_idx on waste_route (vehicle_id, day);`);

  await client.query(`
    create table if not exists waste_route_stop (
      id text primary key,
      route_id text not null references waste_route(id) on delete restrict,
      stop_index int not null,
      kind text not null,
      order_id text null references waste_container_order(id) on delete restrict,
      lat double precision null,
      lon double precision null,
      address text null,
      window_start timestamptz null,
      window_end timestamptz null,
      planned_arrival_at timestamptz null,
      planned_departure_at timestamptz null,
      load_kg int null,
      unload_kg int null,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      unique(route_id, stop_index),
      unique(order_id)
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'waste_route_stop_kind_chk') then
        alter table waste_route_stop add constraint waste_route_stop_kind_chk check (kind in ('deliver','pickup','disposal'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_route_stop_load_chk') then
        alter table waste_route_stop add constraint waste_route_stop_load_chk check ((load_kg is null or load_kg >= 0) and (unload_kg is null or unload_kg >= 0));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists waste_route_stop_route_idx on waste_route_stop (route_id, stop_index);`);
  await client.query(`create index if not exists waste_route_stop_window_idx on waste_route_stop (window_start, window_end);`);
}

