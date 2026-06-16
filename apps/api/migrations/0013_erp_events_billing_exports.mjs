export const id = "0013_erp_events_billing_exports";

export async function up({ client }) {
  await client.query(`
    create table if not exists erp_event (
      id text primary key,
      event_type text not null,
      aggregate_type text not null,
      aggregate_id text not null,
      occurred_at timestamptz not null,
      created_by text not null,
      correlation_id text null,
      payload jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists erp_event_time_idx on erp_event (occurred_at asc, id asc);`);
  await client.query(`create index if not exists erp_event_type_time_idx on erp_event (event_type, occurred_at asc, id asc);`);
  await client.query(`create index if not exists erp_event_agg_time_idx on erp_event (aggregate_type, aggregate_id, occurred_at asc, id asc);`);

  await client.query(`
    create table if not exists erp_event_consumer_offset (
      consumer text primary key,
      last_event_id text null,
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists erp_event_consumer_updated_idx on erp_event_consumer_offset (updated_at desc);`);

  await client.query(`alter table waste_invoice_draft add column if not exists pricing_calculation_id text;`);
  await client.query(`alter table waste_invoice_draft add column if not exists customer_id text;`);
  await client.query(`alter table waste_invoice_draft add column if not exists contract_id text;`);
  await client.query(`alter table waste_invoice_draft add column if not exists meta jsonb;`);
  await client.query(`update waste_invoice_draft set meta = '{}'::jsonb where meta is null;`);
  await client.query(`alter table waste_invoice_draft alter column meta set not null;`);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'waste_invoice_draft_pricing_calc_fk') then
        alter table waste_invoice_draft add constraint waste_invoice_draft_pricing_calc_fk
          foreign key (pricing_calculation_id) references pricing_calculation(id) on delete restrict;
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_invoice_draft_customer_fk') then
        alter table waste_invoice_draft add constraint waste_invoice_draft_customer_fk
          foreign key (customer_id) references crm_customer(id) on delete restrict;
      end if;
      if not exists (select 1 from pg_constraint where conname = 'waste_invoice_draft_contract_fk') then
        alter table waste_invoice_draft add constraint waste_invoice_draft_contract_fk
          foreign key (contract_id) references crm_contract(id) on delete restrict;
      end if;
    end $$;
  `);

  await client.query(`create index if not exists waste_invoice_draft_calc_idx on waste_invoice_draft (pricing_calculation_id, created_at desc);`);
  await client.query(`create index if not exists waste_invoice_draft_customer_idx on waste_invoice_draft (customer_id, created_at desc);`);
}

