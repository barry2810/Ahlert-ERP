export const id = "0012_here_traffic_usage_snapshots";

export async function up({ client }) {
  await client.query(`
    create table if not exists traffic_here_usage_month (
      month text not null,
      endpoint text not null,
      request_count int not null default 0,
      warned_level int not null default 0,
      updated_at timestamptz not null default now(),
      primary key (month, endpoint)
    );
  `);
  await client.query(`create index if not exists traffic_here_usage_month_updated_idx on traffic_here_usage_month (updated_at desc);`);

  await client.query(`
    create table if not exists traffic_here_snapshot (
      id text primary key,
      kind text not null,
      depot_code text not null default '',
      area jsonb not null default '{}'::jsonb,
      fetched_at timestamptz not null,
      expires_at timestamptz not null,
      payload jsonb not null default '{}'::jsonb,
      unique(kind, depot_code)
    );
  `);
  await client.query(`create index if not exists traffic_here_snapshot_kind_idx on traffic_here_snapshot (kind, depot_code, fetched_at desc);`);
  await client.query(`create index if not exists traffic_here_snapshot_expires_idx on traffic_here_snapshot (expires_at);`);
}

