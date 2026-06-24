export const id = "0016_documents_store";

export async function up({ client }) {
  await client.query(`
    create table if not exists doc_document (
      id text primary key,
      doc_type text not null,
      title text not null,
      current_version_id text null,
      created_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      search_text text not null default '',
      search_tsv tsvector generated always as (to_tsvector('simple', search_text)) stored
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'doc_document_type_chk') then
        alter table doc_document add constraint doc_document_type_chk
          check (doc_type in ('contract','weigh_slip','mission_report','inspection_protocol','photo','pdf'));
      end if;
    end $$;
  `);
  await client.query(`create index if not exists doc_document_type_time_idx on doc_document (doc_type, created_at desc);`);
  await client.query(`create index if not exists doc_document_search_tsv_idx on doc_document using gin (search_tsv);`);

  await client.query(`
    create table if not exists doc_version (
      id text primary key,
      document_id text not null references doc_document(id) on delete restrict,
      version_no int not null,
      filename text null,
      mime_type text not null,
      size_bytes int not null,
      content_sha256 text not null,
      storage_backend text not null default 'fs',
      storage_path text not null,
      comment text null,
      created_by text not null,
      created_at timestamptz not null default now(),
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create unique index if not exists doc_version_doc_no_uidx on doc_version (document_id, version_no);`);
  await client.query(`create index if not exists doc_version_doc_time_idx on doc_version (document_id, created_at desc);`);
  await client.query(`create index if not exists doc_version_sha_idx on doc_version (content_sha256);`);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'doc_document_current_version_fk') then
        alter table doc_document add constraint doc_document_current_version_fk
          foreign key (current_version_id) references doc_version(id) on delete restrict;
      end if;
    end $$;
  `);

  await client.query(`
    create table if not exists doc_metadata_field (
      id text primary key,
      doc_type text not null,
      key text not null,
      label text not null,
      value_type text not null,
      required boolean not null default false,
      filterable boolean not null default true,
      fulltext boolean not null default true,
      created_at timestamptz not null default now()
    );
  `);
  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'doc_metadata_field_type_chk') then
        alter table doc_metadata_field add constraint doc_metadata_field_type_chk
          check (doc_type in ('contract','weigh_slip','mission_report','inspection_protocol','photo','pdf'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'doc_metadata_field_value_type_chk') then
        alter table doc_metadata_field add constraint doc_metadata_field_value_type_chk
          check (value_type in ('text','number','date','boolean'));
      end if;
    end $$;
  `);
  await client.query(`create unique index if not exists doc_metadata_field_type_key_uidx on doc_metadata_field (doc_type, key);`);

  await client.query(`
    create table if not exists doc_metadata_value (
      document_id text not null references doc_document(id) on delete restrict,
      field_id text not null references doc_metadata_field(id) on delete restrict,
      value_text text null,
      value_number numeric null,
      value_date date null,
      value_bool boolean null,
      updated_by text not null,
      updated_at timestamptz not null default now(),
      primary key (document_id, field_id)
    );
  `);
  await client.query(`create index if not exists doc_metadata_value_field_idx on doc_metadata_value (field_id);`);
  await client.query(`create index if not exists doc_metadata_value_text_idx on doc_metadata_value (value_text);`);
  await client.query(`create index if not exists doc_metadata_value_number_idx on doc_metadata_value (value_number);`);
  await client.query(`create index if not exists doc_metadata_value_date_idx on doc_metadata_value (value_date);`);
  await client.query(`create index if not exists doc_metadata_value_bool_idx on doc_metadata_value (value_bool);`);

  await client.query(`
    create table if not exists auth_user_signing_key (
      user_id text not null references auth_user(id) on delete restrict,
      alg text not null,
      public_key_pem text not null,
      created_at timestamptz not null default now(),
      primary key (user_id, alg)
    );
  `);
  await client.query(`create index if not exists auth_user_signing_key_alg_idx on auth_user_signing_key (alg);`);

  await client.query(`
    create table if not exists doc_signature (
      id text primary key,
      version_id text not null references doc_version(id) on delete restrict,
      signed_by_user_id text null references auth_user(id) on delete restrict,
      signed_by_username text not null,
      alg text not null,
      signature_base64 text not null,
      signing_payload_sha256 text not null,
      signed_at timestamptz not null default now(),
      meta jsonb not null default '{}'::jsonb
    );
  `);
  await client.query(`create index if not exists doc_signature_version_idx on doc_signature (version_id, signed_at desc);`);
  await client.query(`create unique index if not exists doc_signature_unique_signer_uidx on doc_signature (version_id, signed_by_username, alg);`);

  await client.query(`
    create or replace function doc_rebuild_search_text(p_doc_id text) returns void as $$
    declare
      t text;
      m text;
    begin
      select coalesce(title, '') into t from doc_document where id = p_doc_id;
      select coalesce(string_agg(coalesce(mv.value_text, ''), ' '), '') into m
        from doc_metadata_value mv
        join doc_metadata_field mf on mf.id = mv.field_id
        where mv.document_id = p_doc_id and mf.fulltext = true and mv.value_text is not null;
      update doc_document
      set search_text = trim(both from (coalesce(t,'') || ' ' || coalesce(m,''))),
          updated_at = now()
      where id = p_doc_id;
    end;
    $$ language plpgsql;
  `);

  await client.query(`
    create or replace function doc_trigger_rebuild_search_text() returns trigger as $$
    begin
      perform doc_rebuild_search_text(case when tg_table_name = 'doc_document' then new.id else coalesce(new.document_id, old.document_id) end);
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
  await client.query(`drop function if exists doc_trigger_rebuild_search_text();`);
  await client.query(`drop function if exists doc_rebuild_search_text(text);`);
  await client.query(`drop table if exists doc_signature;`);
  await client.query(`drop table if exists auth_user_signing_key;`);
  await client.query(`drop table if exists doc_metadata_value;`);
  await client.query(`drop table if exists doc_metadata_field;`);
  await client.query(`drop table if exists doc_version;`);
  await client.query(`drop table if exists doc_document;`);
}

