export const id = "0029_main_menu_audit";

export async function up({ client }) {
  await client.query(`
    create table if not exists ui_main_menu_audit (
      id text primary key,
      user_id text null,
      username text not null,
      action text not null,
      section_key text null,
      menu_key text null,
      menu_label text null,
      ip_address text null,
      client text null,
      user_agent text null,
      meta jsonb not null default '{}'::jsonb,
      occurred_at timestamptz not null default now()
    );
  `);

  await client.query(`
    create index if not exists ui_main_menu_audit_user_idx
      on ui_main_menu_audit (username, occurred_at desc);
  `);
  await client.query(`
    create index if not exists ui_main_menu_audit_action_idx
      on ui_main_menu_audit (action, occurred_at desc);
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_trigger where tgname = 'ui_main_menu_audit_no_update') then
        create trigger ui_main_menu_audit_no_update
        before update on ui_main_menu_audit
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'ui_main_menu_audit_no_delete') then
        create trigger ui_main_menu_audit_no_delete
        before delete on ui_main_menu_audit
        for each row execute function deny_audit_modification();
      end if;
    end $$;
  `);
}

export async function down({ client }) {
  await client.query(`drop table if exists ui_main_menu_audit;`);
}