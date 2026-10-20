CREATE TABLE refund_links (
  dataset_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  PRIMARY KEY (dataset_id, refund_id),
  FOREIGN KEY (dataset_id, refund_id) REFERENCES entries(dataset_id, id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id, expense_id) REFERENCES entries(dataset_id, id) ON DELETE RESTRICT
);
CREATE INDEX refunds_by_expense ON refund_links(dataset_id, expense_id);

CREATE TRIGGER refund_link_valid BEFORE INSERT ON refund_links
BEGIN
  SELECT RAISE(ABORT, 'invalid refund association') WHERE NOT EXISTS (
    SELECT 1 FROM entries r JOIN entries p ON p.dataset_id = r.dataset_id
    WHERE r.dataset_id = NEW.dataset_id AND r.id = NEW.refund_id AND r.kind = 'refund'
      AND p.id = NEW.expense_id AND p.kind = 'expense'
      AND (r.deleted_at IS NOT NULL OR (p.deleted_at IS NULL AND r.currency = p.currency
        AND r.original_minor + coalesce((SELECT sum(x.original_minor) FROM refund_links l JOIN entries x
          ON x.dataset_id = l.dataset_id AND x.id = l.refund_id
          WHERE l.dataset_id = NEW.dataset_id AND l.expense_id = NEW.expense_id AND x.deleted_at IS NULL),0) <= p.original_minor))
  );
END;

CREATE TRIGGER refund_update_valid BEFORE UPDATE ON entries
WHEN NEW.deleted_at IS NULL AND EXISTS (SELECT 1 FROM refund_links WHERE dataset_id = OLD.dataset_id AND refund_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'refund exceeds remaining amount or invalid association') WHERE NOT EXISTS (
    SELECT 1 FROM refund_links l JOIN entries p ON p.dataset_id = l.dataset_id AND p.id = l.expense_id
    WHERE l.dataset_id = OLD.dataset_id AND l.refund_id = OLD.id AND NEW.kind = 'refund'
      AND p.kind = 'expense' AND p.deleted_at IS NULL AND NEW.currency = p.currency
      AND NEW.original_minor + coalesce((SELECT sum(x.original_minor) FROM refund_links other JOIN entries x
        ON x.dataset_id = other.dataset_id AND x.id = other.refund_id
        WHERE other.dataset_id = l.dataset_id AND other.expense_id = l.expense_id
          AND x.id <> OLD.id AND x.deleted_at IS NULL),0) <= p.original_minor
  );
END;

CREATE TRIGGER expense_with_refunds_valid BEFORE UPDATE ON entries
WHEN EXISTS (SELECT 1 FROM refund_links l JOIN entries r ON r.dataset_id = l.dataset_id AND r.id = l.refund_id
  WHERE l.dataset_id = OLD.dataset_id AND l.expense_id = OLD.id AND r.deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'handle associated refunds first') WHERE NEW.kind <> 'expense'
    OR NEW.deleted_at IS NOT NULL OR NEW.currency <> OLD.currency
    OR NEW.original_minor < (SELECT sum(r.original_minor) FROM refund_links l JOIN entries r
      ON r.dataset_id = l.dataset_id AND r.id = l.refund_id
      WHERE l.dataset_id = OLD.dataset_id AND l.expense_id = OLD.id AND r.deleted_at IS NULL);
END;
