export const id = "0005_jobs";

export async function up({ client }) {
  await client.query(`
    create table if not exists job (
      id text primary key,
      type text not null,
      status text not null,
      requested_by text not null,
      params jsonb not null default '{}'::jsonb,
      progress int not null default 0,
      total int not null default 100,
      error text null,
      created_at timestamptz not null default now(),
      started_at timestamptz null,
      finished_at timestamptz null,
      locked_at timestamptz null,
      locked_by text null
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'job_status_chk') then
        alter table job add constraint job_status_chk check (status in ('queued','running','succeeded','failed','cancelled'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists job_status_idx on job (status, created_at desc);`);
  await client.query(`create index if not exists job_type_idx on job (type, created_at desc);`);
  await client.query(`create index if not exists job_locked_idx on job (locked_at, status);`);

  await client.query(`
    create table if not exists job_log (
      id text primary key,
      job_id text not null references job(id) on delete restrict,
      level text not null,
      message text not null,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'job_log_level_chk') then
        alter table job_log add constraint job_log_level_chk check (level in ('info','warning','error'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists job_log_job_idx on job_log (job_id, created_at asc);`);
}

