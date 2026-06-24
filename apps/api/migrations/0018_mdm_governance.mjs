export const id = "0018_mdm_governance";

export async function up({ client }) {
  await client.query(`
    create table if not exists mdm_model (
      id text primary key,
      entity_type text not null,
      model_key text not null,
      weights jsonb not null default '{}'::jsonb,
      bias numeric not null default 0,
      threshold numeric not null default 0.85,
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create unique index if not exists mdm_model_entity_key_uidx on mdm_model (entity_type, model_key);`);

  await client.query(`
    create table if not exists mdm_match_candidate (
      id text primary key,
      entity_type text not null,
      left_ref text not null,
      right_ref text not null,
      score numeric not null,
      signals jsonb not null default '{}'::jsonb,
      status text not null default 'open',
      created_at timestamptz not null default now(),
      decided_at timestamptz null,
      decided_by text null,
      decision_reason text null
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'mdm_match_candidate_status_chk') then
        alter table mdm_match_candidate add constraint mdm_match_candidate_status_chk
          check (status in ('open','confirmed','rejected','merged'));
      end if;
    end $$;
  `);
  await client.query(`create unique index if not exists mdm_match_candidate_pair_uidx on mdm_match_candidate (entity_type, left_ref, right_ref);`);
  await client.query(`create index if not exists mdm_match_candidate_status_time_idx on mdm_match_candidate (entity_type, status, created_at desc);`);
  await client.query(`create index if not exists mdm_match_candidate_score_idx on mdm_match_candidate (entity_type, score desc);`);

  await client.query(`
    create table if not exists mdm_golden_record (
      id text primary key,
      entity_type text not null,
      golden_key text not null,
      payload jsonb not null default '{}'::jsonb,
      source_refs jsonb not null default '[]'::jsonb,
      version int not null default 1,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'mdm_golden_record_status_chk') then
        alter table mdm_golden_record add constraint mdm_golden_record_status_chk
          check (status in ('active','superseded','archived'));
      end if;
    end $$;
  `);
  await client.query(`create unique index if not exists mdm_golden_record_entity_key_uidx on mdm_golden_record (entity_type, golden_key);`);
  await client.query(`create index if not exists mdm_golden_record_entity_time_idx on mdm_golden_record (entity_type, updated_at desc);`);

  await client.query(`
    create table if not exists mdm_entity_map (
      entity_type text not null,
      source_ref text not null,
      golden_id text not null references mdm_golden_record(id) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (entity_type, source_ref)
    );
  `);
  await client.query(`create index if not exists mdm_entity_map_golden_idx on mdm_entity_map (golden_id);`);

  await client.query(`
    create table if not exists mdm_quality_issue (
      id text primary key,
      entity_type text not null,
      source_ref text not null,
      issue_type text not null,
      severity text not null,
      message text not null,
      meta jsonb not null default '{}'::jsonb,
      status text not null default 'open',
      created_at timestamptz not null default now(),
      resolved_at timestamptz null,
      resolved_by text null
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'mdm_quality_issue_status_chk') then
        alter table mdm_quality_issue add constraint mdm_quality_issue_status_chk
          check (status in ('open','resolved','ignored'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'mdm_quality_issue_severity_chk') then
        alter table mdm_quality_issue add constraint mdm_quality_issue_severity_chk
          check (severity in ('low','medium','high','critical'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists mdm_quality_issue_open_idx on mdm_quality_issue (status, severity, created_at desc);`);
  await client.query(`create index if not exists mdm_quality_issue_entity_idx on mdm_quality_issue (entity_type, source_ref, created_at desc);`);

  await client.query(`
    create table if not exists mdm_audit (
      id text primary key,
      event_type text not null,
      entity_type text not null,
      golden_id text null,
      source_ref text null,
      username text not null,
      occurred_at timestamptz not null,
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists mdm_audit_time_idx on mdm_audit (occurred_at desc);`);
  await client.query(`create index if not exists mdm_audit_entity_idx on mdm_audit (entity_type, golden_id, occurred_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists mdm_audit;`);
  await client.query(`drop table if exists mdm_quality_issue;`);
  await client.query(`drop table if exists mdm_entity_map;`);
  await client.query(`drop table if exists mdm_golden_record;`);
  await client.query(`drop table if exists mdm_match_candidate;`);
  await client.query(`drop table if exists mdm_model;`);
}

