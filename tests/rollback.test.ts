import { describe, it, expect } from "vitest";
import { parseMigration } from "../src/parsers/flyway-sql.js";
import { generateRollback } from "../src/generators/rollback.js";

describe("Rollback Generator", () => {
  it("reverses CREATE TABLE to DROP TABLE", () => {
    const migration = parseMigration("V1__create_users.sql", "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(100));");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("DROP TABLE IF EXISTS users");
  });

  it("reverses ADD COLUMN to DROP COLUMN", () => {
    const migration = parseMigration("V2__add_email.sql", "ALTER TABLE users ADD COLUMN email VARCHAR(255);");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("DROP COLUMN IF EXISTS email");
  });

  it("reverses CREATE INDEX to DROP INDEX", () => {
    const migration = parseMigration("V3__add_index.sql", "CREATE INDEX idx_users_email ON users (email);");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("DROP INDEX");
    expect(report.rollbackSql).toContain("idx_users_email");
  });

  it("preserves CONCURRENTLY in index rollback", () => {
    const migration = parseMigration("V4__concurrent_idx.sql", "CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status);");
    const report = generateRollback(migration);
    expect(report.rollbackSql).toContain("CONCURRENTLY");
  });

  it("marks DROP TABLE as irreversible", () => {
    const migration = parseMigration("V5__drop_legacy.sql", "DROP TABLE legacy_data;");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.some(w => w.includes("irreversible"))).toBe(true);
  });

  it("marks DROP COLUMN as irreversible", () => {
    const migration = parseMigration("V6__drop_col.sql", "ALTER TABLE users DROP COLUMN legacy_field;");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.some(w => w.includes("data is lost"))).toBe(true);
  });

  it("reverses ADD CONSTRAINT to DROP CONSTRAINT", () => {
    const migration = parseMigration("V7__add_fk.sql", "ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id);");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("DROP CONSTRAINT IF EXISTS fk_orders_user");
  });

  it("reverses SET NOT NULL to DROP NOT NULL", () => {
    const migration = parseMigration("V8__set_not_null.sql", "ALTER TABLE users ALTER COLUMN email SET NOT NULL;");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("DROP NOT NULL");
  });

  it("marks type changes as irreversible", () => {
    const migration = parseMigration("V9__change_type.sql", "ALTER TABLE users ALTER COLUMN name TYPE TEXT;");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.some(w => w.includes("original type"))).toBe(true);
  });

  it("reverses SET DEFAULT to DROP DEFAULT", () => {
    const migration = parseMigration("V9b__set_default.sql", "ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("DROP DEFAULT");
  });

  it("marks DROP DEFAULT as irreversible (original value unknown)", () => {
    const migration = parseMigration("V9c__drop_default.sql", "ALTER TABLE users ALTER COLUMN status DROP DEFAULT;");
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.some(w => w.includes("original default"))).toBe(true);
  });

  it("handles multi-statement migration in reverse order", () => {
    const sql = `
      CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT);
      ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
      CREATE INDEX idx_orders_user ON orders (user_id);
    `;
    const migration = parseMigration("V10__orders.sql", sql);
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.statements.length).toBe(3);
    // Reverse order: index first, then constraint, then table
    expect(report.statements[0].rollback).toContain("DROP INDEX");
    expect(report.statements[1].rollback).toContain("DROP CONSTRAINT");
    expect(report.statements[2].rollback).toContain("DROP TABLE");
  });

  it("includes Flyway schema_version cleanup", () => {
    const migration = parseMigration("V3__add_column.sql", "ALTER TABLE users ADD COLUMN email VARCHAR(255);");
    const report = generateRollback(migration);
    expect(report.rollbackSql).toContain("flyway_schema_history");
    expect(report.rollbackSql).toContain("version = '3'");
  });

  it("handles empty migration", () => {
    const migration = parseMigration("V1__empty.sql", "");
    const report = generateRollback(migration);
    expect(report.statements.length).toBe(0);
    expect(report.fullyReversible).toBe(true);
  });
});

describe("Rollback Generator — RENAME paths", () => {
  it("reverses RENAME TABLE by swapping old and new names", () => {
    const migration = parseMigration("V11__rename_table.sql",
      "ALTER TABLE users RENAME TO legacy_users;"
    );
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("legacy_users RENAME TO users");
  });

  it("reverses RENAME COLUMN by swapping old and new column names", () => {
    const migration = parseMigration("V12__rename_col.sql",
      "ALTER TABLE users RENAME COLUMN name TO full_name;"
    );
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.rollbackSql).toContain("RENAME COLUMN full_name TO name");
  });
});

describe("Rollback Generator — irreversible DROP paths", () => {
  it("marks DROP INDEX as irreversible", () => {
    const migration = parseMigration("V13__drop_idx.sql",
      "DROP INDEX idx_users_email;"
    );
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.some(w => w.includes("DROP INDEX"))).toBe(true);
    expect(report.rollbackSql).toContain("Cannot reverse DROP INDEX");
  });

  it("marks DROP CONSTRAINT as irreversible", () => {
    const migration = parseMigration("V14__drop_constraint.sql",
      "ALTER TABLE orders DROP CONSTRAINT fk_orders_user;"
    );
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.some(w => w.includes("DROP CONSTRAINT"))).toBe(true);
    expect(report.rollbackSql).toContain("fk_orders_user");
  });
});
