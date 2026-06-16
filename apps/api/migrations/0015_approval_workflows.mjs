export const id = "0015_approval_workflows";

export async function up({ client }) {
  await client.query(`
    create table if not exists erp_approval_request (
      id text primary key,
      request_type text not null,
      request_subtype text null,
      status text not null,
      requested_by text not null,
      requested_at timestamptz not null default now(),
      reason text null,
      payload jsonb not null default '{}'::jsonb,
      due_at timestamptz null,
      escalated_at timestamptz null,
      rejected_at timestamptz null,
      rejected_by text null,
      applied_at timestamptz null,
      applied_by text null,
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'erp_approval_request_status_chk') then
        alter table erp_approval_request
          add constraint erp_approval_request_status_chk
          check (status in ('pending', 'approved', 'rejected', 'applied'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists erp_approval_request_status_idx on erp_approval_request (status, requested_at desc);`);
  await client.query(`create index if not exists erp_approval_request_type_idx on erp_approval_request (request_type, requested_at desc);`);
  await client.query(`create index if not exists erp_approval_request_due_idx on erp_approval_request (status, due_at);`);

  await client.query(`
    create table if not exists erp_approval_step (
      id text primary key,
      request_id text not null references erp_approval_request(id) on delete cascade,
      step_no integer not null,
      required_permission text not null,
      escalation_permission text null,
      status text not null default 'pending',
      decided_at timestamptz null,
      decided_by text null,
      decision_reason text null,
      created_at timestamptz not null default now(),
      unique (request_id, step_no)
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'erp_approval_step_status_chk') then
        alter table erp_approval_step
          add constraint erp_approval_step_status_chk
          check (status in ('pending', 'approved', 'rejected', 'escalated'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists erp_approval_step_lookup_idx on erp_approval_step (request_id, step_no);`);
  await client.query(`create index if not exists erp_approval_step_pending_idx on erp_approval_step (status, created_at desc);`);

  await client.query(`
    create table if not exists erp_approval_audit (
      id text primary key,
      request_id text null references erp_approval_request(id) on delete set null,
      entity_type text not null,
      entity_id text null,
      event_type text not null,
      username text not null,
      occurred_at timestamptz not null default now(),
      reason text null,
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists erp_approval_audit_request_idx on erp_approval_audit (request_id, occurred_at desc);`);
  await client.query(`create index if not exists erp_approval_audit_entity_idx on erp_approval_audit (entity_type, entity_id, occurred_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists erp_approval_audit;`);
  await client.query(`drop table if exists erp_approval_step;`);
  await client.query(`drop table if exists erp_approval_request;`);
}

