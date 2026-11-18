ALTER TABLE stage_notes ADD COLUMN author_name TEXT
  CHECK (author_name IS NULL OR length(author_name) BETWEEN 1 AND 30);
