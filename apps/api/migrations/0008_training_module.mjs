export const id = "0008_training_module";

export async function up({ client }) {
  await client.query(`
    create table if not exists training_employee_profile (
      user_id text primary key references auth_user(id) on delete restrict,
      employee_no text null unique,
      cost_center text null,
      team text null,
      supervisor_user_id text null references auth_user(id) on delete set null,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists training_employee_profile_active_team_idx on training_employee_profile (active, team);`);
  await client.query(`create index if not exists training_employee_profile_supervisor_idx on training_employee_profile (supervisor_user_id, active);`);

  await client.query(`
    create table if not exists training_qualification (
      id text primary key,
      code text not null unique,
      name text not null,
      category text not null,
      description text null,
      issuer_type text not null,
      validity_days int null,
      renewal_days_before int not null default 30,
      requires_exam boolean not null default false,
      sensitive boolean not null default false,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_qualification_category_chk') then
        alter table training_qualification add constraint training_qualification_category_chk check (category in ('safety','technical','compliance','other'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_qualification_issuer_type_chk') then
        alter table training_qualification add constraint training_qualification_issuer_type_chk check (issuer_type in ('internal','external'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_qualification_validity_days_chk') then
        alter table training_qualification add constraint training_qualification_validity_days_chk check (validity_days is null or validity_days > 0);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_qualification_renewal_days_before_chk') then
        alter table training_qualification add constraint training_qualification_renewal_days_before_chk check (renewal_days_before >= 0);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_qualification_active_category_idx on training_qualification (active, category);`);

  await client.query(`
    create table if not exists training_qualification_requirement (
      id text primary key,
      qualification_id text not null references training_qualification(id) on delete restrict,
      required_qualification_id text not null references training_qualification(id) on delete restrict,
      required_status text not null default 'valid',
      created_at timestamptz not null default now(),
      unique (qualification_id, required_qualification_id)
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_qualification_requirement_status_chk') then
        alter table training_qualification_requirement add constraint training_qualification_requirement_status_chk check (required_status in ('valid','completed'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_qualification_requirement_not_self_chk') then
        alter table training_qualification_requirement add constraint training_qualification_requirement_not_self_chk check (qualification_id <> required_qualification_id);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_qualification_requirement_q_idx on training_qualification_requirement (qualification_id);`);
  await client.query(`create index if not exists training_qualification_requirement_required_idx on training_qualification_requirement (required_qualification_id);`);

  await client.query(`
    create table if not exists training_course (
      id text primary key,
      code text not null unique,
      name text not null,
      description text null,
      qualification_id text null references training_qualification(id) on delete set null,
      duration_minutes int null,
      delivery_mode text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_course_duration_chk') then
        alter table training_course add constraint training_course_duration_chk check (duration_minutes is null or duration_minutes > 0);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_course_delivery_mode_chk') then
        alter table training_course add constraint training_course_delivery_mode_chk check (delivery_mode in ('in_person','online','blended'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_course_active_qualification_idx on training_course (qualification_id, active);`);

  await client.query(`
    create table if not exists training_session (
      id text primary key,
      course_id text not null references training_course(id) on delete restrict,
      starts_at timestamptz not null,
      ends_at timestamptz not null,
      location text null,
      trainer_user_id text null references auth_user(id) on delete set null,
      capacity int null,
      status text not null,
      created_by text not null references auth_user(id) on delete restrict,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_session_dates_chk') then
        alter table training_session add constraint training_session_dates_chk check (ends_at > starts_at);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_session_capacity_chk') then
        alter table training_session add constraint training_session_capacity_chk check (capacity is null or capacity > 0);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_session_status_chk') then
        alter table training_session add constraint training_session_status_chk check (status in ('scheduled','completed','cancelled'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_session_starts_idx on training_session (starts_at);`);
  await client.query(`create index if not exists training_session_course_starts_idx on training_session (course_id, starts_at desc);`);
  await client.query(`create index if not exists training_session_trainer_starts_idx on training_session (trainer_user_id, starts_at desc);`);

  await client.query(`
    create table if not exists training_session_participant (
      id text primary key,
      session_id text not null references training_session(id) on delete restrict,
      user_id text not null references auth_user(id) on delete restrict,
      status text not null,
      score numeric null,
      note text null,
      decided_by text null references auth_user(id) on delete set null,
      decided_at timestamptz null,
      created_at timestamptz not null default now(),
      unique(session_id, user_id)
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_session_participant_status_chk') then
        alter table training_session_participant add constraint training_session_participant_status_chk check (status in ('assigned','attended','no_show','passed','failed','cancelled'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_session_participant_score_chk') then
        alter table training_session_participant add constraint training_session_participant_score_chk check (score is null or (score >= 0 and score <= 100));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_session_participant_user_idx on training_session_participant (user_id, status);`);

  await client.query(`
    create table if not exists training_exam_plan (
      id text primary key,
      user_id text not null references auth_user(id) on delete restrict,
      qualification_id text not null references training_qualification(id) on delete restrict,
      planned_exam_at timestamptz not null,
      status text not null,
      created_by text not null references auth_user(id) on delete restrict,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_exam_plan_status_chk') then
        alter table training_exam_plan add constraint training_exam_plan_status_chk check (status in ('planned','booked','completed','cancelled'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_exam_plan_time_idx on training_exam_plan (planned_exam_at);`);
  await client.query(`create index if not exists training_exam_plan_user_time_idx on training_exam_plan (user_id, planned_exam_at desc);`);
  await client.query(`create index if not exists training_exam_plan_qual_time_idx on training_exam_plan (qualification_id, planned_exam_at desc);`);

  await client.query(`
    create table if not exists training_credential (
      id text primary key,
      user_id text not null references auth_user(id) on delete restrict,
      qualification_id text not null references training_qualification(id) on delete restrict,
      source text not null,
      issued_at timestamptz not null,
      valid_from date not null,
      valid_to date null,
      status text not null,
      issuer_name text null,
      issued_by_user_id text null references auth_user(id) on delete set null,
      note text null,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_credential_source_chk') then
        alter table training_credential add constraint training_credential_source_chk check (source in ('course','manual','import','external'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_credential_status_chk') then
        alter table training_credential add constraint training_credential_status_chk check (status in ('valid','expired','revoked','suspended'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_credential_valid_range_chk') then
        alter table training_credential add constraint training_credential_valid_range_chk check (valid_to is null or valid_to >= valid_from);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_credential_user_status_validto_idx on training_credential (user_id, status, valid_to);`);
  await client.query(`create index if not exists training_credential_qual_status_validto_idx on training_credential (qualification_id, status, valid_to);`);
  await client.query(`create index if not exists training_credential_validto_idx on training_credential (valid_to);`);

  await client.query(`
    create table if not exists training_credential_event (
      id text primary key,
      credential_id text not null references training_credential(id) on delete restrict,
      event_type text not null,
      username text not null,
      occurred_at timestamptz not null,
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_credential_event_type_chk') then
        alter table training_credential_event add constraint training_credential_event_type_chk check (event_type in ('issued','renewed','expired','revoked','suspended','note_changed','attachment_added'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_credential_event_cred_idx on training_credential_event (credential_id, occurred_at desc);`);
  await client.query(`create index if not exists training_credential_event_type_idx on training_credential_event (event_type, occurred_at desc);`);

  await client.query(`
    create table if not exists training_attachment (
      id text primary key,
      owner_type text not null,
      owner_id text not null,
      filename text not null,
      mime_type text not null,
      byte_size int not null,
      sha256 text not null,
      storage_provider text not null,
      storage_key text not null,
      created_by text not null references auth_user(id) on delete restrict,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'training_attachment_owner_type_chk') then
        alter table training_attachment add constraint training_attachment_owner_type_chk check (owner_type in ('credential','session','exam_plan'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_attachment_storage_provider_chk') then
        alter table training_attachment add constraint training_attachment_storage_provider_chk check (storage_provider in ('db_legacy','s3','minio','filesystem'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'training_attachment_byte_size_chk') then
        alter table training_attachment add constraint training_attachment_byte_size_chk check (byte_size > 0);
      end if;
    end $$;
  `);
  await client.query(`create index if not exists training_attachment_owner_idx on training_attachment (owner_type, owner_id, created_at desc);`);
  await client.query(`create index if not exists training_attachment_sha_idx on training_attachment (sha256);`);
}

