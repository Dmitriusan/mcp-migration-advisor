/**
 * Test against realistic migration files based on common open-source patterns.
 *
 * Migration 1: Keycloak-style — multi-table user/realm schema with FKs, indexes.
 * Migration 2: Dangerous — drops, type changes, NOT NULL without default, CASCADE.
 * Migration 3: Safe practices — CONCURRENTLY, NOT VALID, expand-contract.
 * Migration 4: Quartz-style — large initial schema creation.
 */
import { describe, it, expect } from "vitest";
import { parseMigration } from "../src/parsers/flyway-sql.js";
import { analyzeLockRisks, calculateRiskScore } from "../src/analyzers/lock-risk.js";
import { analyzeDataLoss } from "../src/analyzers/data-loss.js";
import { generateRollback } from "../src/generators/rollback.js";

// Keycloak-style migration: add OAuth2 device flow support
const KEYCLOAK_MIGRATION = `
-- Keycloak 24.0.0 OAuth2 Device Authorization Grant support
-- Based on real Keycloak migration patterns

CREATE TABLE oauth2_device_code (
  id VARCHAR(36) NOT NULL,
  realm_id VARCHAR(255) NOT NULL,
  client_id VARCHAR(255) NOT NULL,
  user_code VARCHAR(8) NOT NULL,
  device_code VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  scope VARCHAR(2048),
  user_session_id VARCHAR(36),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_device_code PRIMARY KEY (id)
);

CREATE TABLE oauth2_device_code_scope (
  device_code_id VARCHAR(36) NOT NULL,
  scope_id VARCHAR(36) NOT NULL,
  CONSTRAINT pk_device_scope PRIMARY KEY (device_code_id, scope_id),
  CONSTRAINT fk_device_scope_code FOREIGN KEY (device_code_id) REFERENCES oauth2_device_code(id) ON DELETE CASCADE
);

ALTER TABLE realm ADD COLUMN device_code_lifespan INTEGER DEFAULT 600;
ALTER TABLE realm ADD COLUMN device_polling_interval INTEGER DEFAULT 5;

CREATE INDEX idx_device_code_user_code ON oauth2_device_code(user_code);
CREATE INDEX idx_device_code_device ON oauth2_device_code(device_code);
CREATE INDEX idx_device_code_realm ON oauth2_device_code(realm_id);
CREATE INDEX idx_device_code_expires ON oauth2_device_code(expires_at);
`;

// Dangerous migration: multiple risky operations
const DANGEROUS_MIGRATION = `
-- DANGEROUS: Production cleanup migration
-- Multiple data loss and locking risks

DROP TABLE IF EXISTS legacy_audit_log CASCADE;

ALTER TABLE users DROP COLUMN middle_name;
ALTER TABLE users DROP COLUMN legacy_role_id;

ALTER TABLE orders ALTER COLUMN amount SET DATA TYPE NUMERIC(10,2);
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;

ALTER TABLE products ADD COLUMN sku VARCHAR(20) NOT NULL;

CREATE INDEX idx_orders_status ON orders(status);

DELETE FROM temp_import_data;

TRUNCATE TABLE session_tokens;
`;

// Safe migration: follows all best practices
const SAFE_MIGRATION = `
-- SAFE: Add analytics tracking with best practices

CREATE TABLE page_views (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT,
  page_url TEXT NOT NULL,
  referrer TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safe: add nullable column first
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;

-- Safe: concurrent index creation
CREATE INDEX CONCURRENTLY idx_page_views_user ON page_views(user_id);
CREATE INDEX CONCURRENTLY idx_page_views_created ON page_views(created_at);

-- Safe: NOT VALID constraint then validate separately
ALTER TABLE page_views ADD CONSTRAINT fk_page_views_user
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
`;

// Quartz Scheduler initial schema (simplified)
const QUARTZ_MIGRATION = `
-- Quartz Scheduler 2.x schema for PostgreSQL

CREATE TABLE qrtz_job_details (
  sched_name VARCHAR(120) NOT NULL,
  job_name VARCHAR(200) NOT NULL,
  job_group VARCHAR(200) NOT NULL,
  description VARCHAR(250),
  job_class_name VARCHAR(250) NOT NULL,
  is_durable BOOLEAN NOT NULL,
  is_nonconcurrent BOOLEAN NOT NULL,
  is_update_data BOOLEAN NOT NULL,
  requests_recovery BOOLEAN NOT NULL,
  job_data BYTEA,
  PRIMARY KEY (sched_name, job_name, job_group)
);

CREATE TABLE qrtz_triggers (
  sched_name VARCHAR(120) NOT NULL,
  trigger_name VARCHAR(200) NOT NULL,
  trigger_group VARCHAR(200) NOT NULL,
  job_name VARCHAR(200) NOT NULL,
  job_group VARCHAR(200) NOT NULL,
  description VARCHAR(250),
  next_fire_time BIGINT,
  prev_fire_time BIGINT,
  priority INTEGER,
  trigger_state VARCHAR(16) NOT NULL,
  trigger_type VARCHAR(8) NOT NULL,
  start_time BIGINT NOT NULL,
  end_time BIGINT,
  calendar_name VARCHAR(200),
  misfire_instr SMALLINT,
  job_data BYTEA,
  PRIMARY KEY (sched_name, trigger_name, trigger_group),
  CONSTRAINT fk_qrtz_triggers_job FOREIGN KEY (sched_name, job_name, job_group)
    REFERENCES qrtz_job_details(sched_name, job_name, job_group)
);

CREATE TABLE qrtz_fired_triggers (
  sched_name VARCHAR(120) NOT NULL,
  entry_id VARCHAR(140) NOT NULL,
  trigger_name VARCHAR(200) NOT NULL,
  trigger_group VARCHAR(200) NOT NULL,
  instance_name VARCHAR(200) NOT NULL,
  fired_time BIGINT NOT NULL,
  sched_time BIGINT NOT NULL,
  priority INTEGER NOT NULL,
  state VARCHAR(16) NOT NULL,
  job_name VARCHAR(200),
  job_group VARCHAR(200),
  is_nonconcurrent BOOLEAN,
  requests_recovery BOOLEAN,
  PRIMARY KEY (sched_name, entry_id)
);

CREATE INDEX idx_qrtz_t_next_fire ON qrtz_triggers(next_fire_time);
CREATE INDEX idx_qrtz_t_state ON qrtz_triggers(trigger_state);
CREATE INDEX idx_qrtz_ft_inst ON qrtz_fired_triggers(instance_name);
CREATE INDEX idx_qrtz_ft_job ON qrtz_fired_triggers(job_name, job_group);
`;

describe("Real-world migration analysis", () => {
  describe("Keycloak-style OAuth2 device flow migration", () => {
    const migration = parseMigration("V24.0.0__add_device_code_flow.sql", KEYCLOAK_MIGRATION);

    it("parses filename correctly", () => {
      expect(migration.version).toBe("24.0.0");
      expect(migration.description).toBe("add device code flow");
      expect(migration.isRepeatable).toBe(false);
    });

    it("detects all DDL statements", () => {
      expect(migration.statements.length).toBe(8);
      const types = migration.statements.map((s) => s.type);
      expect(types.filter((t) => t === "CREATE_TABLE").length).toBe(2);
      expect(types.filter((t) => t === "ADD_COLUMN").length).toBe(2);
      expect(types.filter((t) => t === "CREATE_INDEX").length).toBe(4);
    });

    it("flags non-concurrent indexes as HIGH risk", () => {
      const risks = analyzeLockRisks(migration);
      const indexRisks = risks.filter(
        (r) => r.risk.includes("CONCURRENTLY") && r.severity === "HIGH"
      );
      expect(indexRisks.length).toBe(4);
    });

    it("has moderate risk score (indexes but no destructive ops)", () => {
      const risks = analyzeLockRisks(migration);
      const score = calculateRiskScore(risks);
      // 4 indexes × 20 (HIGH) = 80
      expect(score).toBeGreaterThanOrEqual(60);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("has zero data loss issues", () => {
      const issues = analyzeDataLoss(migration);
      expect(issues.length).toBe(0);
    });

    it("generates fully reversible rollback", () => {
      const rollback = generateRollback(migration);
      expect(rollback.fullyReversible).toBe(true);
      expect(rollback.rollbackSql).toContain("DROP TABLE IF EXISTS oauth2_device_code");
      expect(rollback.rollbackSql).toContain("DROP INDEX");
      expect(rollback.rollbackSql).toContain("flyway_schema_history");
    });
  });

  describe("Dangerous migration — multiple risky operations", () => {
    const migration = parseMigration("V99.0.0__cleanup_legacy.sql", DANGEROUS_MIGRATION);

    it("detects all operations", () => {
      expect(migration.statements.length).toBeGreaterThanOrEqual(8);
    });

    it("flags DROP TABLE CASCADE as CRITICAL", () => {
      const risks = analyzeLockRisks(migration);
      const cascadeRisk = risks.find(
        (r) => r.severity === "CRITICAL" && r.risk.includes("CASCADE")
      );
      expect(cascadeRisk).toBeDefined();
    });

    it("flags NOT NULL without DEFAULT as CRITICAL", () => {
      const risks = analyzeLockRisks(migration);
      const notNullRisk = risks.find(
        (r) => r.severity === "CRITICAL" && r.risk.includes("NOT NULL")
      );
      expect(notNullRisk).toBeDefined();
      expect(notNullRisk!.tableName).toBe("products");
    });

    it("flags type change as CRITICAL", () => {
      const risks = analyzeLockRisks(migration);
      const typeRisk = risks.find(
        (r) => r.severity === "CRITICAL" && r.risk.includes("type")
      );
      expect(typeRisk).toBeDefined();
      expect(typeRisk!.tableName).toBe("orders");
    });

    it("has maximum risk score", () => {
      const risks = analyzeLockRisks(migration);
      const score = calculateRiskScore(risks);
      expect(score).toBe(100);
    });

    it("detects all data loss issues", () => {
      const issues = analyzeDataLoss(migration);
      // DROP TABLE, 2× DROP COLUMN, type change, SET NOT NULL, NOT NULL w/o default, DELETE w/o WHERE, TRUNCATE
      const certain = issues.filter((i) => i.risk === "CERTAIN");
      expect(certain.length).toBeGreaterThanOrEqual(3); // DROP TABLE + 2 DROP COLUMN + DELETE + TRUNCATE
      expect(issues.some((i) => i.description.includes("TRUNCATE"))).toBe(true);
      expect(issues.some((i) => i.description.includes("middle_name"))).toBe(true);
    });

    it("generates non-reversible rollback with warnings", () => {
      const rollback = generateRollback(migration);
      expect(rollback.fullyReversible).toBe(false);
      expect(rollback.warnings.length).toBeGreaterThanOrEqual(3);
      expect(rollback.rollbackSql).toContain("Cannot reverse DROP TABLE");
      expect(rollback.rollbackSql).toContain("Cannot reverse DROP COLUMN");
    });
  });

  describe("Safe migration — best practices", () => {
    const migration = parseMigration("V5.0.0__add_analytics.sql", SAFE_MIGRATION);

    it("parses all statements", () => {
      expect(migration.statements.length).toBeGreaterThanOrEqual(4);
    });

    it("recognizes CONCURRENTLY indexes as INFO (not HIGH)", () => {
      const risks = analyzeLockRisks(migration);
      const indexRisks = risks.filter((r) => r.risk.includes("CONCURRENTLY"));
      for (const r of indexRisks) {
        expect(r.severity).toBe("INFO");
      }
    });

    it("recognizes NOT VALID constraint as good practice", () => {
      const risks = analyzeLockRisks(migration);
      const notValidRisks = risks.filter((r) => r.risk.includes("NOT VALID"));
      expect(notValidRisks.length).toBeGreaterThanOrEqual(1);
      expect(notValidRisks[0].severity).toBe("INFO");
    });

    it("has low risk score", () => {
      const risks = analyzeLockRisks(migration);
      const score = calculateRiskScore(risks);
      // FK adds MEDIUM (10), but CONCURRENTLY and NOT VALID are INFO (0)
      expect(score).toBeLessThanOrEqual(20);
    });

    it("has zero data loss issues", () => {
      const issues = analyzeDataLoss(migration);
      expect(issues.length).toBe(0);
    });

    it("generates fully reversible rollback with CONCURRENTLY drops", () => {
      const rollback = generateRollback(migration);
      expect(rollback.fullyReversible).toBe(true);
      expect(rollback.rollbackSql).toContain("DROP INDEX CONCURRENTLY");
    });
  });

  describe("Quartz Scheduler initial schema", () => {
    const migration = parseMigration("V1__quartz_tables.sql", QUARTZ_MIGRATION);

    it("parses large multi-table migration", () => {
      expect(migration.statements.length).toBe(7); // 3 tables + 4 indexes
    });

    it("detects all CREATE TABLE statements", () => {
      const creates = migration.statements.filter((s) => s.type === "CREATE_TABLE");
      expect(creates.length).toBe(3);
      expect(creates.map((s) => s.tableName)).toContain("qrtz_job_details");
      expect(creates.map((s) => s.tableName)).toContain("qrtz_triggers");
      expect(creates.map((s) => s.tableName)).toContain("qrtz_fired_triggers");
    });

    it("detects all indexes", () => {
      const indexes = migration.statements.filter((s) => s.type === "CREATE_INDEX");
      expect(indexes.length).toBe(4);
    });

    it("flags indexes as HIGH risk (no CONCURRENTLY)", () => {
      const risks = analyzeLockRisks(migration);
      const highIndexRisks = risks.filter(
        (r) => r.severity === "HIGH" && r.risk.includes("INDEX")
      );
      expect(highIndexRisks.length).toBe(4);
    });

    it("has zero data loss risk (pure creation)", () => {
      const issues = analyzeDataLoss(migration);
      expect(issues.length).toBe(0);
    });

    it("generates DROP TABLE rollback in reverse order", () => {
      const rollback = generateRollback(migration);
      expect(rollback.fullyReversible).toBe(true);
      // Rollback is in reverse order: indexes first, then tables
      const stmts = rollback.statements;
      // First rollback statements should be DROP INDEX (indexes were created last)
      expect(stmts[0].rollback).toContain("DROP INDEX");
      // Last rollback statements should be DROP TABLE (tables were created first)
      expect(stmts[stmts.length - 1].rollback).toContain("DROP TABLE");
    });
  });
});
