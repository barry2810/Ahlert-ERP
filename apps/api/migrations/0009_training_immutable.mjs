export const id = "0009_training_immutable";

export async function up({ client }) {
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_proc where proname = 'deny_audit_modification') then
        create function deny_audit_modification() returns trigger as $f$
        begin
          raise exception 'audit_log_is_immutable';
        end;
        $f$ language plpgsql;
      end if;
    end $$;
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_trigger where tgname = 'training_credential_event_no_update') then
        create trigger training_credential_event_no_update
        before update on training_credential_event
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'training_credential_event_no_delete') then
        create trigger training_credential_event_no_delete
        before delete on training_credential_event
        for each row execute function deny_audit_modification();
      end if;
    end $$;
  `);
}

