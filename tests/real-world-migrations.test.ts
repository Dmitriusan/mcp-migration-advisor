import { describe, it, expect } from "vitest";
import { parseMigration } from "../src/parsers/flyway-sql.js";
import { analyzeLockRisks, calculateRiskScore } from "../src/analyzers/lock-risk.js";
import { analyzeDataLoss } from "../src/analyzers/data-loss.js";
import { generateRollback } from "../src/generators/rollback.js";

// Realistic migrations based on common open-source patterns
// (Spring PetClinic, Keycloak, Quarkus quickstarts, etc.)

describe("Real-world migration analysis", () => {
  it("handles Spring PetClinic-style initial schema (safe migration)", () => {
    const sql = `
CREATE TABLE vets (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(30),
  last_name VARCHAR(30)
);

CREATE TABLE specialties (
  id SERIAL PRIMARY KEY,
  name VARCHAR(80)
);

CREATE TABLE vet_specialties (
  vet_id INT NOT NULL,
  specialty_id INT NOT NULL,
  CONSTRAINT fk_vet_specialties_vet FOREIGN KEY (vet_id) REFERENCES vets(id),
  CONSTRAINT fk_vet_specialties_specialty FOREIGN KEY (specialty_id) REFERENCES specialties(id)
);

CREATE TABLE types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(80)
);

CREATE TABLE owners (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(30),
  last_name VARCHAR(30),
  address VARCHAR(255),
  city VARCHAR(80),
  telephone VARCHAR(20)
);

CREATE TABLE pets (
  id SERIAL PRIMARY KEY,
  name VARCHAR(30),
  birth_date DATE,
  type_id INT NOT NULL,
  owner_id INT NOT NULL,
  CONSTRAINT fk_pets_type FOREIGN KEY (type_id) REFERENCES types(id),
  CONSTRAINT fk_pets_owner FOREIGN KEY (owner_id) REFERENCES owners(id)
);

CREATE TABLE visits (
  id SERIAL PRIMARY KEY,
  pet_id INT NOT NULL,
  visit_date DATE,
  description VARCHAR(255),
  CONSTRAINT fk_visits_pet FOREIGN KEY (pet_id) REFERENCES visits(id)
);

CREATE INDEX idx_owners_last_name ON owners (last_name);
CREATE INDEX idx_pets_name ON pets (name);
    `;

    const migration = parseMigration("V1__initial_schema.sql", sql);
    const lockRisks = analyzeLockRisks(migration);
    const dataLossIssues = analyzeDataLoss(migration);
    const riskScore = calculateRiskScore(lockRisks);

    // Initial schema creation has moderate risk (FKs acquire locks on referenced tables)
    expect(riskScore).toBeLessThanOrEqual(50);
    expect(dataLossIssues.length).toBe(0);

    // Should parse all tables and indexes
    const createTables = migration.statements.filter(s => s.type === "CREATE_TABLE");
    const createIndexes = migration.statements.filter(s => s.type === "CREATE_INDEX");
    expect(createTables.length).toBe(7);
    expect(createIndexes.length).toBe(2);

    // Rollback should drop everything in reverse
    const rollback = generateRollback(migration);
    expect(rollback.fullyReversible).toBe(true);
    expect(rollback.rollbackSql).toContain("DROP TABLE IF EXISTS visits");
    expect(rollback.rollbackSql).toContain("DROP INDEX");
  });

  it("detects risks in production ALTER TABLE migration", () => {
    // Common pattern: adding NOT NULL column to existing table
    const sql = `
ALTER TABLE users ADD COLUMN email VARCHAR(255) NOT NULL;
ALTER TABLE users ADD COLUMN phone VARCHAR(20);
CREATE INDEX idx_users_email ON users (email);
ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email);
    `;

    const migration = parseMigration("V5__add_user_contact.sql", sql);
    const lockRisks = analyzeLockRisks(migration);
    const riskScore = calculateRiskScore(lockRisks);

    // ALTER TABLE on existing table has lock risks
    expect(lockRisks.length).toBeGreaterThan(0);
    // Non-concurrent index creation is risky on large tables
    const indexRisks = lockRisks.filter(r => r.risk.toLowerCase().includes("index") || r.risk.toLowerCase().includes("lock"));
    expect(indexRisks.length).toBeGreaterThan(0);
  });

  it("flags dangerous migration with DROP TABLE and DROP COLUMN", () => {
    const sql = `
DROP TABLE IF EXISTS legacy_sessions;
ALTER TABLE users DROP COLUMN old_password_hash;
ALTER TABLE users ALTER COLUMN name TYPE TEXT;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
    `;

    const migration = parseMigration("V10__cleanup_legacy.sql", sql);
    const dataLossIssues = analyzeDataLoss(migration);
    const lockRisks = analyzeLockRisks(migration);
    const riskScore = calculateRiskScore(lockRisks);

    // DROP TABLE and DROP COLUMN should flag data loss
    expect(dataLossIssues.length).toBeGreaterThan(0);
    const dropIssues = dataLossIssues.filter(i =>
      i.description.toLowerCase().includes("drop") ||
      i.risk === "CERTAIN" || i.risk === "LIKELY"
    );
    expect(dropIssues.length).toBeGreaterThan(0);

    // Rollback should be partially irreversible
    const rollback = generateRollback(migration);
    expect(rollback.fullyReversible).toBe(false);
    expect(rollback.warnings.length).toBeGreaterThan(0);
  });

  it("handles Keycloak-style multi-table FK migration", () => {
    const sql = `
CREATE TABLE realm (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(255) UNIQUE,
  enabled BOOLEAN DEFAULT false,
  ssl_required VARCHAR(255),
  registration_allowed BOOLEAN DEFAULT false
);

CREATE TABLE client (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  client_id VARCHAR(255),
  enabled BOOLEAN DEFAULT false,
  realm_id VARCHAR(36),
  CONSTRAINT fk_client_realm FOREIGN KEY (realm_id) REFERENCES realm(id)
);

CREATE TABLE credential (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  type VARCHAR(255),
  value TEXT,
  user_id VARCHAR(36),
  created_date BIGINT
);

CREATE TABLE user_entity (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(255),
  email_verified BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT false,
  realm_id VARCHAR(36),
  username VARCHAR(255),
  CONSTRAINT fk_user_realm FOREIGN KEY (realm_id) REFERENCES realm(id)
);

CREATE INDEX idx_user_email ON user_entity (email);
CREATE INDEX idx_credential_user ON credential (user_id);
    `;

    const migration = parseMigration("V1__keycloak_initial.sql", sql);
    const lockRisks = analyzeLockRisks(migration);
    const riskScore = calculateRiskScore(lockRisks);

    // Initial creation has moderate risk (FKs acquire locks on referenced tables)
    expect(riskScore).toBeLessThanOrEqual(50);

    // Should correctly parse all 4 tables
    const tables = migration.statements.filter(s => s.type === "CREATE_TABLE");
    expect(tables.length).toBe(4);

    // Rollback should be fully reversible
    const rollback = generateRollback(migration);
    expect(rollback.fullyReversible).toBe(true);
    expect(rollback.statements.length).toBe(6); // 4 tables + 2 indexes
  });

  it("handles concurrent index creation (PostgreSQL best practice)", () => {
    const sql = `
CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at);
CREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders (customer_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status ON orders (status);
    `;

    const migration = parseMigration("V20__add_order_indexes.sql", sql);
    const lockRisks = analyzeLockRisks(migration);
    const riskScore = calculateRiskScore(lockRisks);

    // CONCURRENTLY should reduce risk
    expect(migration.statements.length).toBe(3);
    expect(migration.statements.every(s => s.type === "CREATE_INDEX")).toBe(true);

    // Rollback should preserve CONCURRENTLY
    const rollback = generateRollback(migration);
    expect(rollback.fullyReversible).toBe(true);
    for (const stmt of rollback.statements) {
      expect(stmt.rollback).toContain("CONCURRENTLY");
    }
  });

  it("handles complex migration with RENAME and CONSTRAINT changes", () => {
    const sql = `
ALTER TABLE customer RENAME TO users;
ALTER TABLE users RENAME COLUMN full_name TO display_name;
ALTER TABLE users ADD CONSTRAINT chk_email CHECK (email LIKE '%@%');
ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    `;

    const migration = parseMigration("V15__refactor_customers.sql", sql);

    // Rollback should reverse renames correctly
    const rollback = generateRollback(migration);
    expect(rollback.rollbackSql).toContain("RENAME TO customer");
    expect(rollback.rollbackSql).toContain("RENAME COLUMN display_name TO full_name");
    expect(rollback.rollbackSql).toContain("DROP CONSTRAINT");

    // Rollback should be in reverse order
    expect(rollback.statements[0].rollback).toContain("DROP CONSTRAINT");
    expect(rollback.statements[rollback.statements.length - 1].rollback).toContain("RENAME TO customer");
  });

  it("does not flag TRUNCATE/DELETE inside CREATE FUNCTION body as data loss", () => {
    // A stored function that contains TRUNCATE or DELETE is only risky when invoked,
    // not when the migration that creates it is applied. We must not fire data-loss
    // warnings just because the function body text contains these keywords.
    const sql = `
CREATE OR REPLACE FUNCTION purge_old_records() RETURNS void AS $$
BEGIN
  DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days';
  TRUNCATE TABLE staging_import;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE users ADD COLUMN last_purge_at TIMESTAMPTZ;
    `;

    const migration = parseMigration("V20__add_purge_function.sql", sql);
    const dataLossIssues = analyzeDataLoss(migration);

    // The CREATE FUNCTION should produce no data-loss issues — it does not
    // execute the DELETE or TRUNCATE at migration time.
    const functionBodyIssues = dataLossIssues.filter(i =>
      i.description.toLowerCase().includes("audit_log") ||
      i.description.toLowerCase().includes("staging_import") ||
      i.description.toLowerCase().includes("truncate")
    );
    expect(functionBodyIssues).toHaveLength(0);

    // The ADD COLUMN statement has no data-loss risk either
    expect(dataLossIssues).toHaveLength(0);
  });

  it("still flags standalone TRUNCATE at migration top level", () => {
    const sql = `
ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'active';
TRUNCATE TABLE migration_temp;
    `;

    const migration = parseMigration("V21__add_status_and_cleanup.sql", sql);
    const dataLossIssues = analyzeDataLoss(migration);

    const truncateIssue = dataLossIssues.find(i =>
      i.description.toLowerCase().includes("truncate") ||
      i.tableName === "migration_temp"
    );
    expect(truncateIssue).toBeDefined();
    expect(truncateIssue!.risk).toBe("CERTAIN");
  });
});
