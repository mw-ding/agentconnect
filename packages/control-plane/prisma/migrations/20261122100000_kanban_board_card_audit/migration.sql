-- Board CRUD and card transitions (create, status, assignee) leave body-free audit rows.
ALTER TYPE "AuditKind" ADD VALUE 'kanban_board_change';
ALTER TYPE "AuditKind" ADD VALUE 'kanban_card_change';
