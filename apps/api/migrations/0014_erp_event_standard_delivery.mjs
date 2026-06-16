export const id = "0014_erp_event_standard_delivery";

export async function up({ client }) {
  await client.query(`alter table erp_event add column if not exists schema_version int;`);
  await client.query(`update erp_event set schema_version = 1 where schema_version is null;`);
  await client.query(`alter table erp_event alter column schema_version set not null;`);
  await client.query(`alter table erp_event alter column schema_version set default 1;`);

  await client.query(`alter table erp_event add column if not exists source_module text;`);
  await client.query(`update erp_event set source_module = 'unknown' where source_module is null;`);
  await client.query(`alter table erp_event alter column source_module set not null;`);
  await client.query(`alter table erp_event alter column source_module set default 'unknown';`);

  await client.query(`alter table erp_event add column if not exists causation_id text;`);
  await client.query(`alter table erp_event add column if not exists trace_id text;`);
  await client.query(`alter table erp_event add column if not exists partition_key text;`);
  await client.query(`alter table erp_event add column if not exists headers jsonb;`);
  await client.query(`update erp_event set headers = '{}'::jsonb where headers is null;`);
  await client.query(`alter table erp_event alter column headers set not null;`);
  await client.query(`alter table erp_event alter column headers set default '{}'::jsonb;`);

  await client.query(`create index if not exists erp_event_source_time_idx on erp_event (source_module, occurred_at asc, id asc);`);
  await client.query(`create index if not exists erp_event_trace_idx on erp_event (trace_id);`);

  await client.query(`
    create table if not exists erp_event_delivery (
      id text primary key,
      consumer text not null,
      event_id text not null references erp_event(id) on delete restrict,
      status text not null,
      attempt_no int not null,
      processed_at timestamptz not null,
      error_code text null,
      error_message text null,
      meta jsonb not null default '{}'::jsonb
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'erp_event_delivery_status_chk') then
        alter table erp_event_delivery add constraint erp_event_delivery_status_chk
          check (status in ('delivered','failed','ignored'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'erp_event_delivery_attempt_chk') then
        alter table erp_event_delivery add constraint erp_event_delivery_attempt_chk
          check (attempt_no > 0);
      end if;
    end $$;
  `);

  await client.query(`create index if not exists erp_event_delivery_consumer_time_idx on erp_event_delivery (consumer, processed_at desc);`);
  await client.query(`create index if not exists erp_event_delivery_event_idx on erp_event_delivery (event_id, processed_at desc);`);
  await client.query(`create unique index if not exists erp_event_delivery_consumer_attempt_uidx on erp_event_delivery (consumer, event_id, attempt_no);`);
}

