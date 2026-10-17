# One-time database upgrades

## `2026-10-16-kanban-migration-rename.sql`

**Who needs it:** a control-plane database migrated on the old fork `main`
(up to `dab68d6`, preserved as `backup/main-pre-upstream-2026-10-16`). Fresh
databases, and databases that never ran the fork's Kanban migrations, don't
need it. Running it there is a harmless no-op.

**Why:** the 2026-10-16 upstream sync renamed the 11 Kanban migrations
(`20260818000000_kanban_board_card_run` … `20261016120000_kanban_run_reported_block_kind`
→ `20261121000000_…` … `20261121100000_…`) so they sort after upstream's
latest. The SQL is byte-identical, so checksums match, but Prisma tracks
migrations by name. Without this script, `prisma migrate deploy` tries to
re-apply them and fails with `P3018 … type "KanbanCardStatus" already exists`.

**When:** once, after deploying the synced code and **before** its first
`prisma migrate deploy`. If a deploy already failed with P3018, run it and
deploy again. The script clears the failed attempt's row.

**How:**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/control-plane/prisma/upgrade/2026-10-16-kanban-migration-rename.sql
pnpm --filter @agentconnect.md/control-plane exec prisma migrate deploy
pnpm --filter @agentconnect.md/control-plane exec prisma migrate status # expect: Database schema is up to date
```

The script runs in one transaction and prints a `NOTICE` for each row it
renames. It raises without changing anything if an old and a new name are
both recorded as applied. That state needs a human look.

**Schema parity:** an upgraded database matches a fresh 134-migration one
except for the position of the `kanban_mode_change` value in the `AuditKind`
enum. A fresh database adds it after upstream's later `memory_change` value;
an upgraded one already had it earlier. Nothing orders by this enum, so the
difference is cosmetic.
