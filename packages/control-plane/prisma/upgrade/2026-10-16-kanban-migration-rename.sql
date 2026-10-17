-- One-time upgrade: rename the fork's Kanban migrations in _prisma_migrations
-- (2026-10-16 upstream sync). See README.md in this directory.
--
-- The upstream sync moved the 11 Kanban migrations so they sort after
-- upstream's latest (20261120000000). Their SQL is byte-identical, so their
-- checksums are unchanged; only the directory names changed. A database built
-- on the old fork main has the old names recorded, so `prisma migrate deploy`
-- would try to re-apply them under the new names and fail with P3018.
--
-- Idempotent and transactional: a fresh database, an already-renamed one, or
-- a rerun is a no-op. A failed attempt of a new name (left by a P3018 deploy,
-- finished_at IS NULL) is cleared when the old name is recorded as applied.
-- Refuses (raises) if both the old and new names are recorded as applied.
BEGIN;
DO $$
DECLARE
  m record;
BEGIN
  IF to_regclass('_prisma_migrations') IS NULL THEN
    RAISE NOTICE 'no _prisma_migrations table; nothing to do';
    RETURN;
  END IF;
  FOR m IN SELECT * FROM (VALUES
    ('20260818000000_kanban_board_card_run', '20261121000000_kanban_board_card_run'),
    ('20260819000000_kanban_dispatch_lease', '20261121010000_kanban_dispatch_lease'),
    ('20260820000000_kanban_mode_config', '20261121020000_kanban_mode_config'),
    ('20260821000000_kanban_recovery_backoff', '20261121030000_kanban_recovery_backoff'),
    ('20260822000000_kanban_mode_revision_audit', '20261121040000_kanban_mode_revision_audit'),
    ('20261016000000_kanban_recovery_followups', '20261121050000_kanban_recovery_followups'),
    ('20261016010000_kanban_promotion_write_receipt', '20261121060000_kanban_promotion_write_receipt'),
    ('20261016020000_kanban_promotion_event_id', '20261121070000_kanban_promotion_event_id'),
    ('20261016030000_kanban_promotion_cursor', '20261121080000_kanban_promotion_cursor'),
    ('20261016040000_kanban_promotion_watch', '20261121090000_kanban_promotion_watch'),
    ('20261016120000_kanban_run_reported_block_kind', '20261121100000_kanban_run_reported_block_kind')
  ) AS t(old_name, new_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = m.old_name) THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = m.new_name AND finished_at IS NOT NULL) THEN
      RAISE EXCEPTION 'both % and % are recorded as applied; resolve by hand', m.old_name, m.new_name;
    END IF;
    DELETE FROM _prisma_migrations WHERE migration_name = m.new_name AND finished_at IS NULL;
    UPDATE _prisma_migrations SET migration_name = m.new_name WHERE migration_name = m.old_name;
    RAISE NOTICE 'renamed % -> %', m.old_name, m.new_name;
  END LOOP;
END
$$;
COMMIT;
