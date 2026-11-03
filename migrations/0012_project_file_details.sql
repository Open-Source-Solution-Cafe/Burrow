-- Additive SQLite metadata; existing registrations remain valid and reusable.
ALTER TABLE project_files ADD COLUMN filename TEXT;
ALTER TABLE project_files ADD COLUMN byte_size INTEGER;
