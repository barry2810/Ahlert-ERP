export const id = "0025_business_rule_engine";

export async function up({ client }) {
  await client.query(`
    create table if not exists business_rule (
      id text primary key,
      rule_key text not null unique,
      name text not null,
      domain text not null,
      active boolean not null default true,
      priority int not null default 100,
      stop_on_match boolean not null default false,
      valid_from date null,
      valid_to date null,
      conditions jsonb not null default '{}'::jsonb,
      actions jsonb not null default '[]'::jsonb,
      tags text[] not null default '{}'::text[],
      meta jsonb not null default '{}'::jsonb,
      created_by text not null,
      updated_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'business_rule_priority_chk') then
        alter table business_rule add constraint business_rule_priority_chk check (priority >= 0);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'business_rule_valid_range_chk') then
        alter table business_rule add constraint business_rule_valid_range_chk check (valid_to is null or valid_from is null or valid_to >= valid_from);
      end if;
      if not exists (select 1 from pg_constraint where conname = 'business_rule_domain_chk') then
        alter table business_rule add constraint business_rule_domain_chk check (domain ~ '^[a-z0-9_:-]+$');
      end if;
    end $$;
  `);

  await client.query(`create index if not exists business_rule_domain_active_idx on business_rule (domain, active, priority desc, updated_at desc);`);
  await client.query(`create index if not exists business_rule_validity_idx on business_rule (active, valid_from, valid_to);`);
  await client.query(`create index if not exists business_rule_tags_idx on business_rule using gin (tags);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists business_rule;`);
}
