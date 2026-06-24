export const id = "0017_documents_search_trigger_fix";

export async function up({ client }) {
  await client.query(`drop trigger if exists doc_metadata_value_search_trg on doc_metadata_value;`);
  await client.query(`drop trigger if exists doc_document_search_trg on doc_document;`);

  await client.query(`
    create or replace function doc_trigger_rebuild_search_text() returns trigger as $$
    declare
      j jsonb;
      did text;
    begin
      if tg_op = 'DELETE' then
        j := to_jsonb(old);
      else
        j := to_jsonb(new);
      end if;
      if tg_table_name = 'doc_document' then
        did := j->>'id';
      else
        did := j->>'document_id';
      end if;
      if did is not null and did <> '' then
        perform doc_rebuild_search_text(did);
      end if;
      return null;
    end;
    $$ language plpgsql;
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_trigger where tgname = 'doc_document_search_trg') then
        create trigger doc_document_search_trg
        after insert or update of title on doc_document
        for each row execute function doc_trigger_rebuild_search_text();
      end if;
      if not exists (select 1 from pg_trigger where tgname = 'doc_metadata_value_search_trg') then
        create trigger doc_metadata_value_search_trg
        after insert or update or delete on doc_metadata_value
        for each row execute function doc_trigger_rebuild_search_text();
      end if;
    end $$;
  `);
}

export async function down({ client }) {
  await client.query(`drop trigger if exists doc_metadata_value_search_trg on doc_metadata_value;`);
  await client.query(`drop trigger if exists doc_document_search_trg on doc_document;`);
}

