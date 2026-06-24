export const id = "0020_cost_accounting_finance_entries";

export async function up({ client }) {
  await client.query(`
    create table if not exists finance_entry (
      id text primary key,
      entry_type text not null,
      object_type text not null,
      object_id text not null,
      currency text not null default 'EUR',
      amount_cents int not null,
      occurred_at timestamptz not null,
      cost_center text null,
      account text null,
      source_module text not null,
      source_ref_type text null,
      source_ref_id text null,
      meta jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'finance_entry_type_chk') then
        alter table finance_entry add constraint finance_entry_type_chk check (entry_type in ('revenue','cost'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'finance_entry_currency_chk') then
        alter table finance_entry add constraint finance_entry_currency_chk check (currency ~ '^[A-Z]{3}$');
      end if;
      if not exists (select 1 from pg_constraint where conname = 'finance_entry_amount_chk') then
        alter table finance_entry add constraint finance_entry_amount_chk check (amount_cents >= 0);
      end if;
    end $$;
  `);

  await client.query(`create index if not exists finance_entry_object_time_idx on finance_entry (object_type, object_id, occurred_at desc);`);
  await client.query(`create index if not exists finance_entry_type_time_idx on finance_entry (entry_type, occurred_at desc);`);
  await client.query(`create index if not exists finance_entry_cost_center_time_idx on finance_entry (cost_center, occurred_at desc);`);
  await client.query(`create index if not exists finance_entry_source_ref_idx on finance_entry (source_module, source_ref_type, source_ref_id);`);
  await client.query(`create unique index if not exists finance_entry_source_ref_uidx on finance_entry (source_module, source_ref_type, source_ref_id, entry_type);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists finance_entry;`);
  await client.query(`drop index if exists finance_entry_object_time_idx;`);
  await client.query(`drop index if exists finance_entry_type_time_idx;`);
  await client.query(`drop index if exists finance_entry_cost_center_time_idx;`);
  await client.query(`drop index if exists finance_entry_source_ref_idx;`);
  await client.query(`drop index if exists finance_entry_source_ref_uidx;`);
}

