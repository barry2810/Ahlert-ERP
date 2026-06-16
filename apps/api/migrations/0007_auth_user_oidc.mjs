export const id = "0007_auth_user_oidc";

export async function up({ client }) {
  await client.query(`alter table auth_user add column if not exists identity_provider text;`);
  await client.query(`alter table auth_user add column if not exists identity_subject text;`);
  await client.query(`alter table auth_user add column if not exists email text;`);
  await client.query(`alter table auth_user add column if not exists last_login_at timestamptz;`);
  await client.query(`create index if not exists auth_user_identity_idx on auth_user (identity_provider, identity_subject);`);
  await client.query(`create index if not exists auth_user_email_idx on auth_user (email);`);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'auth_user_identity_unique') then
        alter table auth_user add constraint auth_user_identity_unique unique (identity_provider, identity_subject);
      end if;
    end $$;
  `);
}

