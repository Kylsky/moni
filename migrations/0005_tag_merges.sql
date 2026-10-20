ALTER TABLE tags ADD COLUMN merged_into TEXT;

CREATE TRIGGER tag_merge_target_insert BEFORE INSERT ON tags
WHEN NEW.merged_into IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid tag merge target') WHERE NEW.id = NEW.merged_into OR NOT EXISTS (
    SELECT 1 FROM tags WHERE dataset_id = NEW.dataset_id AND id = NEW.merged_into AND merged_into IS NULL
  );
END;
CREATE TRIGGER tag_merge_target_update BEFORE UPDATE OF merged_into ON tags
WHEN NEW.merged_into IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid tag merge target') WHERE NEW.id = NEW.merged_into OR NOT EXISTS (
    SELECT 1 FROM tags WHERE dataset_id = NEW.dataset_id AND id = NEW.merged_into AND merged_into IS NULL
  );
END;
CREATE TRIGGER entry_tag_canonical_insert BEFORE INSERT ON entry_tags
BEGIN
  SELECT RAISE(ABORT, 'entry tag must be canonical') WHERE NOT EXISTS (
    SELECT 1 FROM tags WHERE dataset_id = NEW.dataset_id AND id = NEW.tag_id AND merged_into IS NULL
  );
END;
