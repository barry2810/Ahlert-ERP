export const id = "0019_jobs_retries_dlq_priorities";

export async function up({ client }) {
  await client.query(`alter table job add column if not exists priority int;`);
  await client.query(`alter table job add column if not exists run_at timestamptz;`);
  await client.query(`alter table job add column if not exists attempts int;`);
  await client.query(`alter table job add column if not exists max_attempts int;`);
  await client.query(`alter table job add column if not exists retry_backoff_ms int;`);
  await client.query(`alter table job add column if not exists retry_max_backoff_ms int;`);
  await client.query(`alter table job add column if not exists last_error text;`);
  await client.query(`alter table job add column if not exists last_error_at timestamptz;`);
  await client.query(`alter table job add column if not exists dead_lettered_at timestamptz;`);
  await client.query(`alter table job add column if not exists dead_letter_reason text;`);

  await client.query(`update job set priority = 100 where priority is null;`);
  await client.query(`update job set run_at = coalesce(created_at, now()) where run_at is null;`);
  await client.query(`update job set attempts = 0 where attempts is null;`);
  await client.query(`update job set max_attempts = 3 where max_attempts is null;`);
  await client.query(`update job set retry_backoff_ms = 2000 where retry_backoff_ms is null;`);
  await client.query(`update job set retry_max_backoff_ms = 60000 where retry_max_backoff_ms is null;`);

  await client.query(`alter table job alter column priority set not null;`);
  await client.query(`alter table job alter column run_at set not null;`);
  await client.query(`alter table job alter column attempts set not null;`);
  await client.query(`alter table job alter column max_attempts set not null;`);
  await client.query(`alter table job alter column retry_backoff_ms set not null;`);
  await client.query(`alter table job alter column retry_max_backoff_ms set not null;`);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'job_attempts_chk') then
        alter table job add constraint job_attempts_chk check (attempts >= 0);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'job_max_attempts_chk') then
        alter table job add constraint job_max_attempts_chk check (max_attempts >= 1);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'job_retry_backoff_chk') then
        alter table job add constraint job_retry_backoff_chk check (retry_backoff_ms >= 0 and retry_max_backoff_ms >= retry_backoff_ms);
      end if;
    end $$;
  `);

  await client.query(`
    do $$
    begin
      if exists (select 1 from pg_constraint where conname = 'job_status_chk') then
        alter table job drop constraint job_status_chk;
      end if;
      alter table job add constraint job_status_chk check (status in ('queued','running','succeeded','failed','cancelled','dead'));
    end $$;
  `);

  await client.query(`create index if not exists job_pick_idx on job (status, run_at asc, priority asc, created_at asc);`);
  await client.query(`create index if not exists job_type_pick_idx on job (type, status, run_at asc, priority asc, created_at asc);`);
  await client.query(`create index if not exists job_dead_lettered_idx on job (status, dead_lettered_at desc);`);

  await client.query(`
    create table if not exists job_dead_letter (
      id text primary key,
      job_id text not null references job(id) on delete restrict,
      job_type text not null,
      requested_by text not null,
      params jsonb not null default '{}'::jsonb,
      attempts int not null,
      max_attempts int not null,
      reason text not null,
      error text null,
      created_at timestamptz not null default now(),
      requeued_at timestamptz null,
      requeued_by text null
    );
  `);
  await client.query(`create unique index if not exists job_dead_letter_job_uidx on job_dead_letter (job_id);`);
  await client.query(`create index if not exists job_dead_letter_created_idx on job_dead_letter (created_at desc);`);
  await client.query(`create index if not exists job_dead_letter_type_idx on job_dead_letter (job_type, created_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists job_dead_letter;`);
  await client.query(`drop index if exists job_dead_letter_job_uidx;`);
  await client.query(`drop index if exists job_dead_letter_created_idx;`);
  await client.query(`drop index if exists job_dead_letter_type_idx;`);
  await client.query(`drop index if exists job_pick_idx;`);
  await client.query(`drop index if exists job_type_pick_idx;`);
  await client.query(`drop index if exists job_dead_lettered_idx;`);
  await client.query(`alter table job drop column if exists priority;`);
  await client.query(`alter table job drop column if exists run_at;`);
  await client.query(`alter table job drop column if exists attempts;`);
  await client.query(`alter table job drop column if exists max_attempts;`);
  await client.query(`alter table job drop column if exists retry_backoff_ms;`);
  await client.query(`alter table job drop column if exists retry_max_backoff_ms;`);
  await client.query(`alter table job drop column if exists last_error;`);
  await client.query(`alter table job drop column if exists last_error_at;`);
  await client.query(`alter table job drop column if exists dead_lettered_at;`);
  await client.query(`alter table job drop column if exists dead_letter_reason;`);
}

