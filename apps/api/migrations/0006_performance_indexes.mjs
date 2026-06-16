export const id = "0006_performance_indexes";

export async function up({ client }) {
  await client.query(`create index if not exists workshop_inventory_movement_occurred_idx on workshop_inventory_movement (occurred_at desc, id desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_type_idx on workshop_inventory_movement (movement_type, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_unit_time_idx on workshop_inventory_movement (unit_id, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_case_time_idx on workshop_inventory_movement (case_id, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_item_time_idx on workshop_inventory_movement (item_id, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_from_time_idx on workshop_inventory_movement (from_location_id, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_movement_to_time_idx on workshop_inventory_movement (to_location_id, occurred_at desc);`);
  await client.query(`create index if not exists workshop_inventory_item_part_no_idx on workshop_inventory_item (part_no);`);
  await client.query(`create index if not exists workshop_inventory_location_code_idx on workshop_inventory_location (code);`);
  await client.query(`create index if not exists workshop_case_assigned_to_idx on workshop_case (assigned_to, opened_at desc);`);
  await client.query(`create index if not exists workshop_case_opened_idx on workshop_case (opened_at desc, id desc);`);
}

