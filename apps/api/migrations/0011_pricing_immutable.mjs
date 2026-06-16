export const id = "0011_pricing_immutable";

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
      if not exists (select 1 from pg_trigger where tgname = 'pricing_calculation_event_no_update') then
        create trigger pricing_calculation_event_no_update
        before update on pricing_calculation_event
        for each row execute function deny_audit_modification();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'pricing_calculation_event_no_delete') then
        create trigger pricing_calculation_event_no_delete
        before delete on pricing_calculation_event
        for each row execute function deny_audit_modification();
      end if;
    end $$;
  `);
}

