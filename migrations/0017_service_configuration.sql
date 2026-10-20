-- Deployment configuration is deliberately outside dataset-scoped business backups.
CREATE TABLE service_configuration (
  name TEXT PRIMARY KEY CHECK (name = 'ai'),
  encrypted_value TEXT,
  version INTEGER NOT NULL CHECK (version > 0)
);
