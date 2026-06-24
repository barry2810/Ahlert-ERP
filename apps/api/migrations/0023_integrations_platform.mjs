export const id = "0023_integrations_platform";

export async function up({ client }) {
  await client.query(`
    create table if not exists integration_system (
      id text primary key,
      kind text not null,
      name text not null,
      status text not null,
      config jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'integration_system_status_chk') then
        alter table integration_system add constraint integration_system_status_chk check (status in ('active','disabled'));
      end if;
    end $$;
  `);

  await client.query(`create index if not exists integration_system_kind_idx on integration_system (kind, created_at desc);`);
  await client.query(`create index if not exists integration_system_status_idx on integration_system (status, updated_at desc);`);

  await client.query(`
    create table if not exists integration_subscription (
      id text primary key,
      system_id text not null references integration_system(id) on delete restrict,
      active boolean not null default true,
      event_types text[] not null default '{}'::text[],
      aggregate_type text null,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`create index if not exists integration_subscription_system_idx on integration_subscription (system_id, active, updated_at desc);`);
  await client.query(`create index if not exists integration_subscription_aggregate_idx on integration_subscription (aggregate_type, updated_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists integration_subscription;`);
  await client.query(`drop table if exists integration_system;`);
}
