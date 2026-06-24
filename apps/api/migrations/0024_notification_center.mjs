export const id = "0024_notification_center";

export async function up({ client }) {
  await client.query(`
    create table if not exists notification_channel_config (
      channel text primary key,
      enabled boolean not null default true,
      provider text not null,
      config jsonb not null default '{}'::jsonb,
      quality_standard jsonb not null default '{}'::jsonb,
      updated_by text not null,
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists notification_rule (
      id text primary key,
      rule_key text not null unique,
      name text not null,
      active boolean not null default true,
      event_type text not null,
      aggregate_type text null,
      channels text[] not null default '{}'::text[],
      priority text not null,
      ack_required boolean not null default false,
      sla_minutes int not null default 60,
      audience jsonb not null default '{}'::jsonb,
      escalation_policy jsonb not null default '[]'::jsonb,
      template jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'notification_rule_priority_chk') then
        alter table notification_rule add constraint notification_rule_priority_chk
          check (priority in ('low','medium','high','critical'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'notification_rule_sla_chk') then
        alter table notification_rule add constraint notification_rule_sla_chk
          check (sla_minutes >= 1);
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists notification_message (
      id text primary key,
      rule_id text null references notification_rule(id) on delete set null,
      event_type text not null,
      aggregate_type text not null,
      aggregate_id text not null,
      title text not null,
      message text not null,
      priority text not null,
      status text not null,
      ack_required boolean not null default false,
      audience jsonb not null default '{}'::jsonb,
      channels text[] not null default '{}'::text[],
      payload jsonb not null default '{}'::jsonb,
      correlation_id text null,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      sla_due_at timestamptz null,
      acknowledged_at timestamptz null,
      acknowledged_by text null,
      escalated_at timestamptz null,
      escalation_level int not null default 0,
      resolved_at timestamptz null,
      resolved_by text null
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'notification_message_priority_chk') then
        alter table notification_message add constraint notification_message_priority_chk
          check (priority in ('low','medium','high','critical'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'notification_message_status_chk') then
        alter table notification_message add constraint notification_message_status_chk
          check (status in ('queued','dispatched','delivered','acknowledged','escalated','breached','resolved','cancelled'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'notification_message_escalation_level_chk') then
        alter table notification_message add constraint notification_message_escalation_level_chk
          check (escalation_level >= 0);
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists notification_delivery (
      id text primary key,
      notification_id text not null references notification_message(id) on delete cascade,
      channel text not null,
      status text not null,
      provider text not null,
      recipient text null,
      attempt_no int not null default 1,
      requested_at timestamptz not null,
      processed_at timestamptz null,
      delivered_at timestamptz null,
      error_code text null,
      error_message text null,
      latency_ms int null,
      meta jsonb not null default '{}'::jsonb
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'notification_delivery_status_chk') then
        alter table notification_delivery add constraint notification_delivery_status_chk
          check (status in ('queued','delivered','failed','skipped'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'notification_delivery_attempt_chk') then
        alter table notification_delivery add constraint notification_delivery_attempt_chk
          check (attempt_no >= 1);
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists notification_escalation (
      id text primary key,
      notification_id text not null references notification_message(id) on delete cascade,
      level_no int not null,
      status text not null,
      trigger_at timestamptz not null,
      triggered_at timestamptz null,
      action jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'notification_escalation_level_chk') then
        alter table notification_escalation add constraint notification_escalation_level_chk
          check (level_no >= 1);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'notification_escalation_status_chk') then
        alter table notification_escalation add constraint notification_escalation_status_chk
          check (status in ('pending','triggered','cancelled'));
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists notification_audit (
      id text primary key,
      notification_id text not null references notification_message(id) on delete cascade,
      event_type text not null,
      actor text not null,
      occurred_at timestamptz not null,
      meta jsonb not null default '{}'::jsonb
    );
  `);

  await client.query(`create index if not exists notification_rule_event_idx on notification_rule (event_type, active, updated_at desc);`);
  await client.query(`create index if not exists notification_message_status_idx on notification_message (status, created_at desc);`);
  await client.query(`create index if not exists notification_message_due_idx on notification_message (status, sla_due_at asc);`);
  await client.query(`create index if not exists notification_message_aggregate_idx on notification_message (aggregate_type, aggregate_id, created_at desc);`);
  await client.query(`create index if not exists notification_delivery_notification_idx on notification_delivery (notification_id, requested_at asc);`);
  await client.query(`create index if not exists notification_delivery_channel_idx on notification_delivery (channel, status, requested_at desc);`);
  await client.query(`create index if not exists notification_escalation_trigger_idx on notification_escalation (status, trigger_at asc);`);
  await client.query(`create index if not exists notification_audit_notification_idx on notification_audit (notification_id, occurred_at asc);`);

  await client.query(`
    insert into notification_channel_config (channel, enabled, provider, config, quality_standard, updated_by, updated_at)
    values
      ('email', true, 'log', '{"mode":"log"}'::jsonb, '{"targetDeliveryMs":300000,"targetAccuracyPct":99.5}'::jsonb, 'system', now()),
      ('push', true, 'log', '{"mode":"log"}'::jsonb, '{"targetDeliveryMs":60000,"targetAccuracyPct":99.0}'::jsonb, 'system', now()),
      ('in_app', true, 'in_app', '{"mode":"store"}'::jsonb, '{"targetDeliveryMs":5000,"targetAccuracyPct":99.9}'::jsonb, 'system', now())
    on conflict (channel) do nothing;
  `);

  await client.query(`
    insert into notification_rule
      (id, rule_key, name, active, event_type, aggregate_type, channels, priority, ack_required, sla_minutes, audience, escalation_policy, template, created_by, created_at, updated_at)
    values
      (
        'nr_approval_requested_default',
        'approval_requested_default',
        'Approval Requested Default',
        true,
        'APPROVAL_REQUESTED',
        'approval_request',
        array['email','in_app'],
        'high',
        true,
        120,
        '{}'::jsonb,
        '[{"level":1,"afterMinutes":120,"channels":["email","push","in_app"],"audience":{}}]'::jsonb,
        '{"category":"approval"}'::jsonb,
        'system',
        now(),
        now()
      ),
      (
        'nr_approval_escalated_default',
        'approval_escalated_default',
        'Approval Escalated Default',
        true,
        'APPROVAL_ESCALATED',
        'approval_request',
        array['email','push','in_app'],
        'critical',
        true,
        60,
        '{}'::jsonb,
        '[{"level":1,"afterMinutes":60,"channels":["email","push","in_app"],"audience":{}}]'::jsonb,
        '{"category":"approval"}'::jsonb,
        'system',
        now(),
        now()
      ),
      (
        'nr_deadline_due_default',
        'deadline_due_default',
        'Deadline Due Default',
        true,
        'DEADLINE_DUE',
        'deadline',
        array['push','in_app'],
        'high',
        true,
        60,
        '{}'::jsonb,
        '[{"level":1,"afterMinutes":60,"channels":["email","push","in_app"],"audience":{}}]'::jsonb,
        '{"category":"deadline"}'::jsonb,
        'system',
        now(),
        now()
      ),
      (
        'nr_oncall_dispatch_default',
        'oncall_dispatch_default',
        'Oncall Dispatch Default',
        true,
        'ONCALL_DISPATCH',
        'oncall_assignment',
        array['push','in_app'],
        'critical',
        true,
        30,
        '{}'::jsonb,
        '[{"level":1,"afterMinutes":30,"channels":["email","push","in_app"],"audience":{}}]'::jsonb,
        '{"category":"oncall"}'::jsonb,
        'system',
        now(),
        now()
      )
    on conflict (rule_key) do nothing;
  `);
}

export async function down({ client }) {
  await client.query(`drop table if exists notification_audit;`);
  await client.query(`drop table if exists notification_escalation;`);
  await client.query(`drop table if exists notification_delivery;`);
  await client.query(`drop table if exists notification_message;`);
  await client.query(`drop table if exists notification_rule;`);
  await client.query(`drop table if exists notification_channel_config;`);
}
