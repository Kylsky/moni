ALTER TABLE refund_links ADD COLUMN default_base_minor INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(default_base_minor) = 'integer' AND default_base_minor BETWEEN 0 AND 9000000000000);
ALTER TABLE refund_links ADD COLUMN actual_override INTEGER NOT NULL DEFAULT 0 CHECK(actual_override IN (0,1));
UPDATE refund_links SET default_base_minor = (SELECT base_minor FROM entries
  WHERE entries.dataset_id = refund_links.dataset_id AND entries.id = refund_links.refund_id);

CREATE VIEW refund_allocations AS
  SELECT l.dataset_id,l.expense_id,sum(r.original_minor) AS original_minor,sum(l.default_base_minor) AS default_minor
  FROM refund_links l JOIN entries r ON r.dataset_id=l.dataset_id AND r.id=l.refund_id
  WHERE r.deleted_at IS NULL GROUP BY l.dataset_id,l.expense_id;

CREATE TRIGGER refund_budget_insert BEFORE INSERT ON refund_links
WHEN EXISTS (SELECT 1 FROM entries WHERE dataset_id=NEW.dataset_id AND id=NEW.refund_id AND deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'refund allocation changed') WHERE EXISTS (
    SELECT 1 FROM entries p JOIN entries r ON r.dataset_id=p.dataset_id AND r.id=NEW.refund_id
    LEFT JOIN refund_allocations a ON a.dataset_id=p.dataset_id AND a.expense_id=p.id
    WHERE p.dataset_id=NEW.dataset_id AND p.id=NEW.expense_id
      AND (NEW.default_base_minor+coalesce(a.default_minor,0)>p.base_minor
        OR (r.original_minor+coalesce(a.original_minor,0)=p.original_minor
          AND NEW.default_base_minor+coalesce(a.default_minor,0)<>p.base_minor))
  );
END;

CREATE TRIGGER refund_budget_update BEFORE UPDATE ON refund_links
BEGIN
  SELECT RAISE(ABORT,'refund association is immutable') WHERE NEW.dataset_id<>OLD.dataset_id
    OR NEW.refund_id<>OLD.refund_id OR NEW.expense_id<>OLD.expense_id;
  SELECT RAISE(ABORT,'refund allocation changed') WHERE EXISTS (
    SELECT 1 FROM entries p JOIN refund_allocations a ON a.dataset_id=p.dataset_id AND a.expense_id=p.id
    JOIN entries r ON r.dataset_id=NEW.dataset_id AND r.id=NEW.refund_id AND r.deleted_at IS NULL
    WHERE p.dataset_id=NEW.dataset_id AND p.id=NEW.expense_id
      AND (a.default_minor-OLD.default_base_minor+NEW.default_base_minor>p.base_minor
        OR (a.original_minor=p.original_minor AND a.default_minor-OLD.default_base_minor+NEW.default_base_minor<>p.base_minor))
  );
END;

CREATE TRIGGER refund_budget_restore BEFORE UPDATE ON entries
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT,'refund allocation changed') WHERE EXISTS (
    SELECT 1 FROM refund_links own JOIN entries p ON p.dataset_id=own.dataset_id AND p.id=own.expense_id
    LEFT JOIN refund_allocations a ON a.dataset_id=p.dataset_id AND a.expense_id=p.id
    WHERE own.dataset_id=OLD.dataset_id AND own.refund_id=OLD.id
      AND (own.default_base_minor+coalesce(a.default_minor,0)>p.base_minor
        OR (NEW.original_minor+coalesce(a.original_minor,0)=p.original_minor
          AND own.default_base_minor+coalesce(a.default_minor,0)<>p.base_minor))
  );
END;

CREATE TRIGGER expense_refund_budget BEFORE UPDATE ON entries
BEGIN
  SELECT RAISE(ABORT,'handle allocated refunds before repricing') WHERE EXISTS (
    SELECT 1 FROM refund_allocations a WHERE a.dataset_id=OLD.dataset_id AND a.expense_id=OLD.id
      AND (a.default_minor>NEW.base_minor OR (a.original_minor=NEW.original_minor AND a.default_minor<>NEW.base_minor))
  );
END;
