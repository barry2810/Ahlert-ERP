export const id = "0021_reporting_data_mart";

export async function up({ client }) {
  await client.query(`
    create table if not exists rpt_waste_order_fact (
      order_id text primary key,
      customer_ref_id text null,
      contract_id text null,
      municipality_id text null,
      disposal_site_id text null,
      status text not null,
      service_type text not null,
      container_source_key text not null,
      material_code text null,
      planned_tons double precision null,
      planned_volume_cbm double precision null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      invoice_draft_id text null,
      invoice_currency text null,
      invoice_total_cents int null,
      invoiced_at timestamptz null,
      last_refreshed_at timestamptz not null default now()
    );
  `);

  await client.query(`create index if not exists rpt_waste_order_status_idx on rpt_waste_order_fact (status, updated_at desc);`);
  await client.query(`create index if not exists rpt_waste_order_customer_idx on rpt_waste_order_fact (customer_ref_id, updated_at desc);`);
  await client.query(`create index if not exists rpt_waste_order_created_idx on rpt_waste_order_fact (created_at desc);`);
  await client.query(`create index if not exists rpt_waste_order_invoiced_idx on rpt_waste_order_fact (invoiced_at desc);`);

  await client.query(`
    create table if not exists rpt_finance_daily (
      day date not null,
      currency text not null,
      cost_center text null,
      revenue_cents bigint not null,
      cost_cents bigint not null,
      contribution_cents bigint not null,
      last_refreshed_at timestamptz not null default now(),
      primary key (day, currency, cost_center)
    );
  `);
  await client.query(`create index if not exists rpt_finance_daily_day_idx on rpt_finance_daily (day desc);`);
  await client.query(`create index if not exists rpt_finance_daily_cc_idx on rpt_finance_daily (cost_center, day desc);`);

  await client.query(`
    create table if not exists rpt_waste_daily (
      day date primary key,
      orders_created int not null,
      orders_invoiced int not null,
      invoice_revenue_cents bigint not null,
      planned_tons double precision not null,
      last_refreshed_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists rpt_waste_daily_day_idx on rpt_waste_daily (day desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists rpt_waste_daily;`);
  await client.query(`drop table if exists rpt_finance_daily;`);
  await client.query(`drop table if exists rpt_waste_order_fact;`);
}

