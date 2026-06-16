export const id = "0001_auth";

export async function up({ client }) {
  await client.query(`
    create table if not exists auth_user (
      id text primary key,
      username text not null unique,
      display_name text null,
      password_alg text not null,
      password_salt text not null,
      password_hash text not null,
      password_params jsonb not null default '{}'::jsonb,
      disabled boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists auth_user_username_idx on auth_user (username);`);

  await client.query(`
    create table if not exists auth_role (
      id text primary key,
      name text not null unique,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`create index if not exists auth_role_name_idx on auth_role (name);`);

  await client.query(`
    create table if not exists auth_permission (
      name text primary key,
      created_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create table if not exists auth_role_permission (
      role_id text not null references auth_role(id) on delete restrict,
      permission_name text not null references auth_permission(name) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (role_id, permission_name)
    );
  `);
  await client.query(`create index if not exists auth_role_permission_perm_idx on auth_role_permission (permission_name);`);

  await client.query(`
    create table if not exists auth_user_role (
      user_id text not null references auth_user(id) on delete restrict,
      role_id text not null references auth_role(id) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (user_id, role_id)
    );
  `);
  await client.query(`create index if not exists auth_user_role_role_idx on auth_user_role (role_id);`);

  await client.query(`
    create table if not exists auth_session (
      id text primary key,
      user_id text not null references auth_user(id) on delete restrict,
      refresh_token_sha256 text not null,
      csrf_token_sha256 text not null,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      rotated_at timestamptz null,
      revoked_at timestamptz null,
      replaced_by text null,
      ip text null,
      user_agent text null
    );
  `);
  await client.query(`create index if not exists auth_session_user_idx on auth_session (user_id, created_at desc);`);
  await client.query(`create index if not exists auth_session_refresh_idx on auth_session (refresh_token_sha256);`);
  await client.query(`create index if not exists auth_session_active_idx on auth_session (user_id, expires_at, revoked_at, rotated_at);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists auth_session;`);
  await client.query(`drop table if exists auth_user_role;`);
  await client.query(`drop table if exists auth_role_permission;`);
  await client.query(`drop table if exists auth_permission;`);
  await client.query(`drop table if exists auth_role;`);
  await client.query(`drop table if exists auth_user;`);
}

