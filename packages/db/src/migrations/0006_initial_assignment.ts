import { Kysely, sql } from 'kysely';

// F003-T1 (#51, ADR 0001): an Asset's Location, OrganizationUnit and Responsible Person become its
// Permanent Assignment, built from assignment facts. Each event is one business action with an
// Effective Date and a Recorded At; each change records one dimension's prior and new value.

// Each dimension: its name, its entry column in assignment_changes, the Reference List that column
// names, and its Feature 002 columns on `assets` (0005_reference_context), the entry and the Legacy
// text, which this migration carries over into Initial Assignments and then drops.
const DIMENSIONS = [
  ['LOCATION', 'location_id', 'locations', 'location_id', 'legacy_location_text'],
  ['ORGANIZATION_UNIT', 'organization_unit_id', 'organization_units', 'organization_unit_id', 'legacy_organization_unit_text'],
  ['RESPONSIBLE_PERSON', 'person_id', 'persons', 'responsible_person_id', 'legacy_responsible_person_text'],
] as const;

// The Feature 002 fact fields that hold dimension values, in REGISTERED payloads and in CORRECTED changes.
const FEATURE_002_FIELDS = sql.raw(
  `ARRAY[${DIMENSIONS.flatMap(([, , , entry, legacy]) => [`'${entry}'`, `'${legacy}'`]).join(', ')}]::text[]`
);

// Blank Legacy text holds no wording, so it is no value; other text is carried exactly as stored.
const legacyValue = (column: string) => sql.raw(`CASE WHEN btrim(a.${column}) <> '' THEN a.${column} END`);
const hasValue = (entry: string, legacy: string) => sql.raw(`(a.${entry} IS NOT NULL OR btrim(a.${legacy}) <> '')`);

export async function up(db: Kysely<any>): Promise<void> {
  // Every assignment write checks and increments this version (the spec's stale-before guard).
  await db.schema
    .alterTable('assets')
    .addColumn('assignment_version', 'integer', (col) =>
      col.defaultTo(0).notNull().check(sql`assignment_version >= 0`)
    )
    .execute();

  await db.schema
    .createTable('assignment_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('asset_id', 'uuid', (col) => col.references('assets.id').onDelete('restrict').notNull())
    .addColumn('kind', 'varchar(20)', (col) => col.notNull().check(sql`kind IN ('INITIAL', 'REASSIGNMENT')`))
    // NULL is "ไม่ทราบ" (unknown), allowed only on an Initial Assignment (Q11).
    .addColumn('effective_date', 'date')
    .addColumn('recorded_at', 'timestamptz', (col) => col.defaultTo(sql`now()`).notNull())
    .addColumn('recorded_by', 'uuid', (col) => col.references('users.id').onDelete('restrict').notNull())
    .addColumn('provenance', 'varchar(30)', (col) =>
      col.notNull().check(sql`provenance IN ('RECORDED', 'CARRIED_OVER_F002')`)
    )
    .addColumn('document_reference', 'text', (col) => col.check(sql`btrim(document_reference) <> ''`))
    .addColumn('remark', 'text', (col) => col.check(sql`btrim(remark) <> ''`))
    .addCheckConstraint('assignment_events_date_unknown_only_initial', sql`effective_date IS NOT NULL OR kind = 'INITIAL'`)
    .addCheckConstraint('assignment_events_carried_over_only_initial', sql`provenance = 'RECORDED' OR kind = 'INITIAL'`)
    // Lets each change name its event's kind, so the database keeps new Legacy text to Initial Assignments.
    .addUniqueConstraint('assignment_events_id_kind', ['id', 'kind'])
    .execute();

  // At most one Initial Assignment per Asset.
  await sql`CREATE UNIQUE INDEX assignment_events_one_initial ON assignment_events (asset_id) WHERE kind = 'INITIAL'`.execute(db);
  // The order of an Asset's facts: Effective Date with unknown first, then Recorded At, then id.
  await sql`CREATE INDEX idx_assignment_events_order
    ON assignment_events (asset_id, effective_date ASC NULLS FIRST, recorded_at, id)`.execute(db);

  let changes = db.schema
    .createTable('assignment_changes')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`).notNull())
    .addColumn('event_id', 'uuid', (col) => col.notNull())
    .addColumn('event_kind', 'varchar(20)', (col) => col.notNull())
    .addColumn('dimension', 'varchar(30)', (col) =>
      col.notNull().check(sql`dimension IN ('LOCATION', 'ORGANIZATION_UNIT', 'RESPONSIBLE_PERSON')`)
    );
  for (const side of ['prior', 'new'] as const) {
    for (const [, column, table] of DIMENSIONS) {
      changes = changes.addColumn(`${side}_${column}`, 'uuid', (col) => col.references(`${table}.id`).onDelete('restrict'));
    }
    changes = changes.addColumn(`${side}_legacy_text`, 'text', (col) => col.check(sql`btrim(${sql.ref(`${side}_legacy_text`)}) <> ''`));
  }
  await changes
    .addForeignKeyConstraint('assignment_changes_event', ['event_id', 'event_kind'], 'assignment_events', ['id', 'kind'], (fk) =>
      fk.onDelete('restrict')
    )
    .addUniqueConstraint('assignment_changes_one_per_dimension', ['event_id', 'dimension'])
    // Each entry belongs to its own dimension's list.
    .addCheckConstraint(
      'assignment_changes_own_list',
      sql`CASE dimension
        WHEN 'LOCATION' THEN num_nonnulls(prior_organization_unit_id, prior_person_id, new_organization_unit_id, new_person_id) = 0
        WHEN 'ORGANIZATION_UNIT' THEN num_nonnulls(prior_location_id, prior_person_id, new_location_id, new_person_id) = 0
        WHEN 'RESPONSIBLE_PERSON' THEN num_nonnulls(prior_location_id, prior_organization_unit_id, new_location_id, new_organization_unit_id) = 0
        ELSE false
      END`
    )
    // New Legacy text appears only on an Initial Assignment (Q14).
    .addCheckConstraint('assignment_changes_legacy_text_only_initial', sql`new_legacy_text IS NULL OR event_kind = 'INITIAL'`)
    .execute();

  // Each Asset with a Feature 002 value or Legacy text gets one Initial Assignment (#51, Q11):
  // Effective Date unknown, carried over from Feature 002, with the recorder and time of the most
  // recent registration or correction fact that set a dimension value. An Asset whose values no
  // fact set (text written outside the API) takes its own registration's recorder and time.
  const anyValue = sql.join(
    DIMENSIONS.map(([, , , entry, legacy]) => hasValue(entry, legacy)),
    sql` OR `
  );
  await sql`
    INSERT INTO assignment_events (asset_id, kind, effective_date, recorded_at, recorded_by, provenance)
    SELECT a.id, 'INITIAL', NULL, COALESCE(f.recorded_at, a.recorded_at), COALESCE(f.actor_id, a.registered_by),
           'CARRIED_OVER_F002'
    FROM assets a
    LEFT JOIN LATERAL (
      SELECT h.actor_id, h.recorded_at
      FROM asset_history h
      WHERE h.asset_id = a.id
        AND ((h.action = 'REGISTERED' AND EXISTS (
               SELECT 1
               FROM jsonb_each(CASE WHEN jsonb_typeof(h.payload) = 'object' THEN h.payload ELSE '{}'::jsonb END) kv
               WHERE kv.key = ANY(${FEATURE_002_FIELDS}) AND kv.value <> 'null'::jsonb))
          OR (h.action = 'CORRECTED' AND EXISTS (
               SELECT 1
               FROM jsonb_each(CASE WHEN jsonb_typeof(h.payload -> 'changes') = 'object'
                                    THEN h.payload -> 'changes' ELSE '{}'::jsonb END) kv
               WHERE kv.key = ANY(${FEATURE_002_FIELDS})
                 AND COALESCE(kv.value -> 'after', 'null'::jsonb) <> 'null'::jsonb)))
      ORDER BY h.recorded_at DESC, h.created_at DESC, h.id DESC
      LIMIT 1
    ) f ON true
    WHERE ${anyValue}
  `.execute(db);

  for (const [dimension, column, , entry, legacy] of DIMENSIONS) {
    await sql`
      INSERT INTO assignment_changes (event_id, event_kind, dimension, ${sql.ref(`new_${column}`)}, new_legacy_text)
      SELECT e.id, e.kind, ${dimension}, ${sql.ref(`a.${entry}`)}, ${legacyValue(legacy)}
      FROM assignment_events e
      JOIN assets a ON a.id = e.asset_id
      WHERE ${hasValue(entry, legacy)}
    `.execute(db);
  }
  await sql`UPDATE assets SET assignment_version = 1 WHERE id IN (SELECT asset_id FROM assignment_events)`.execute(db);

  // One truth remains: the Current Assignment is derived from the facts. Dropping a column drops its
  // index and foreign key.
  for (const [, , , entry, legacy] of DIMENSIONS) {
    await db.schema.alterTable('assets').dropColumn(entry).execute();
    await db.schema.alterTable('assets').dropColumn(legacy).execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Refuse a destructive rollback while any assignment fact exists.
  const facts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM assignment_events`.execute(db);
  if (Number(facts.rows[0]?.count || '0') > 0) {
    throw new Error('Refusing destructive rollback: assignment facts exist');
  }

  // With no facts there are no values to restore: the Feature 002 columns return empty, as 0005 made them.
  for (const [, , table, entry, legacy] of DIMENSIONS) {
    await db.schema.alterTable('assets').addColumn(legacy, 'text').execute();
    await db.schema
      .alterTable('assets')
      .addColumn(entry, 'uuid', (col) => col.references(`${table}.id`).onDelete('restrict'))
      .execute();
    await db.schema.createIndex(`idx_assets_${entry}`).on('assets').column(entry).execute();
  }

  await db.schema.dropTable('assignment_changes').ifExists().execute();
  await db.schema.dropTable('assignment_events').ifExists().execute();
  await db.schema.alterTable('assets').dropColumn('assignment_version').execute();
}
