export const id = "0026_self_service_portal";

export async function up({ client }) {
  await client.query(`
    create table if not exists portal_account (
      id text primary key,
      portal_type text not null,
      display_name text not null,
      email text not null unique,
      password_hash text not null,
      customer_id text null references crm_customer(id) on delete set null,
      supplier_id text null references workshop_inventory_supplier(id) on delete set null,
      active boolean not null default true,
      settings jsonb not null default '{}'::jsonb,
      last_login_at timestamptz null,
      created_by text not null,
      updated_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists portal_assignment (
      id text primary key,
      account_id text not null references portal_account(id) on delete cascade,
      scope_type text not null,
      scope_id text not null,
      access_level text not null default 'rw',
      status text not null default 'active',
      meta jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now(),
      unique (account_id, scope_type, scope_id)
    );
  `);

  await client.query(`
    create table if not exists portal_document_link (
      id text primary key,
      account_id text not null references portal_account(id) on delete cascade,
      document_id text not null references doc_document(id) on delete cascade,
      label text null,
      meta jsonb not null default '{}'::jsonb,
      created_by text not null,
      created_at timestamptz not null default now(),
      unique (account_id, document_id)
    );
  `);

  await client.query(`
    create table if not exists portal_audit (
      id text primary key,
      account_id text null references portal_account(id) on delete set null,
      action text not null,
      actor text not null,
      meta jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'portal_account_type_chk') then
        alter table portal_account add constraint portal_account_type_chk check (portal_type in ('customer','subcontractor'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'portal_account_subject_chk') then
        alter table portal_account add constraint portal_account_subject_chk check (
          (portal_type = 'customer' and customer_id is not null)
          or (portal_type = 'subcontractor' and supplier_id is not null)
        );
      end if;
      if not exists (select 1 from pg_constraint where conname = 'portal_assignment_scope_chk') then
        alter table portal_assignment add constraint portal_assignment_scope_chk check (scope_type in ('order','route'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'portal_assignment_access_chk') then
        alter table portal_assignment add constraint portal_assignment_access_chk check (access_level in ('r','rw'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'portal_assignment_status_chk') then
        alter table portal_assignment add constraint portal_assignment_status_chk check (status in ('active','revoked'));
      end if;
    end $$;
  `);

  await client.query(`create index if not exists portal_account_email_idx on portal_account (lower(email));`);
  await client.query(`create index if not exists portal_account_type_idx on portal_account (portal_type, active);`);
  await client.query(`create index if not exists portal_assignment_account_idx on portal_assignment (account_id, scope_type, status, created_at desc);`);
  await client.query(`create index if not exists portal_assignment_scope_idx on portal_assignment (scope_type, scope_id, status);`);
  await client.query(`create index if not exists portal_document_link_account_idx on portal_document_link (account_id, created_at desc);`);
  await client.query(`create index if not exists portal_audit_account_idx on portal_audit (account_id, occurred_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists portal_audit;`);
  await client.query(`drop table if exists portal_document_link;`);
  await client.query(`drop table if exists portal_assignment;`);
  await client.query(`drop table if exists portal_account;`);
}
