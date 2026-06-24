export const id = "0027_media_processing_ocr";

export async function up({ client }) {
  await client.query(`
    alter table doc_document drop constraint if exists doc_document_type_chk;
  `);
  await client.query(`
    alter table doc_document add constraint doc_document_type_chk
      check (doc_type in ('contract','weigh_slip','mission_report','inspection_protocol','photo','pdf','scan','video'));
  `);

  await client.query(`
    alter table doc_metadata_field drop constraint if exists doc_metadata_field_type_chk;
  `);
  await client.query(`
    alter table doc_metadata_field add constraint doc_metadata_field_type_chk
      check (doc_type in ('contract','weigh_slip','mission_report','inspection_protocol','photo','pdf','scan','video'));
  `);

  await client.query(`
    create table if not exists doc_media_analysis (
      version_id text primary key references doc_version(id) on delete cascade,
      document_id text not null references doc_document(id) on delete cascade,
      media_kind text not null,
      status text not null default 'processed',
      ocr_text text null,
      ocr_language text null,
      preview_storage_path text null,
      page_count int null,
      width_px int null,
      height_px int null,
      duration_seconds numeric null,
      frame_count int null,
      facts jsonb not null default '{}'::jsonb,
      error_text text null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  await client.query(`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'doc_media_analysis_kind_chk') then
        alter table doc_media_analysis add constraint doc_media_analysis_kind_chk
          check (media_kind in ('image','video','pdf','text','other'));
      end if;
      if not exists (select 1 from pg_constraint where conname = 'doc_media_analysis_status_chk') then
        alter table doc_media_analysis add constraint doc_media_analysis_status_chk
          check (status in ('processed','failed','skipped'));
      end if;
    end $$;
  `);

  await client.query(`create index if not exists doc_media_analysis_document_idx on doc_media_analysis (document_id, updated_at desc);`);
  await client.query(`create index if not exists doc_media_analysis_kind_idx on doc_media_analysis (media_kind, status, updated_at desc);`);
}

export async function down({ client }) {
  await client.query(`drop table if exists doc_media_analysis;`);
  await client.query(`alter table doc_metadata_field drop constraint if exists doc_metadata_field_type_chk;`);
  await client.query(`
    alter table doc_metadata_field add constraint doc_metadata_field_type_chk
      check (doc_type in ('contract','weigh_slip','mission_report','inspection_protocol','photo','pdf'));
  `);
  await client.query(`alter table doc_document drop constraint if exists doc_document_type_chk;`);
  await client.query(`
    alter table doc_document add constraint doc_document_type_chk
      check (doc_type in ('contract','weigh_slip','mission_report','inspection_protocol','photo','pdf'));
  `);
}
