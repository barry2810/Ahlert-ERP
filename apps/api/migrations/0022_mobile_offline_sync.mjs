export const id = "0022_mobile_offline_sync";

export async function up({ client }) {
  await client.query(`
    create table if not exists mobile_id_map (
      device_id text not null,
      entity_type text not null,
      local_id text not null,
      server_id text not null,
      created_by text not null,
      created_at timestamptz not null default now(),
      primary key (device_id, entity_type, local_id)
    );
  `);
  await client.query(`create index if not exists mobile_id_map_server_idx on mobile_id_map (entity_type, server_id);`);

  await client.query(`
    create table if not exists mobile_sync_op (
      id text primary key,
      device_id text not null,
      op_id text not null,
      op_type text not null,
      occurred_at timestamptz null,
      payload jsonb not null default '{}'::jsonb,
      status text not null,
      attempt_no int not null default 0,
      result jsonb not null default '{}'::jsonb,
      error_code text null,
      error_message text null,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      applied_at timestamptz null
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'mobile_sync_op_status_chk') then
        alter table mobile_sync_op add constraint mobile_sync_op_status_chk check (status in ('queued','running','applied','failed'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'mobile_sync_op_attempt_chk') then
        alter table mobile_sync_op add constraint mobile_sync_op_attempt_chk check (attempt_no >= 0);
      end if;
    end $$;
  `);

  await client.query(`create unique index if not exists mobile_sync_op_device_op_uidx on mobile_sync_op (device_id, op_id);`);
  await client.query(`create index if not exists mobile_sync_op_device_status_idx on mobile_sync_op (device_id, status, updated_at desc);`);
  await client.query(`create index if not exists mobile_sync_op_device_time_idx on mobile_sync_op (device_id, created_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists mobile_sync_op;`);
  await client.query(`drop table if exists mobile_id_map;`);
}

