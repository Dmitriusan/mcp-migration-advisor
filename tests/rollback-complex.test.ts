import { describe, it, expect } from "vitest";
import { parseMigration } from "../src/parsers/flyway-sql.js";
import { generateRollback } from "../src/generators/rollback.js";

describe("Rollback Generator — complex migrations", () => {
  it("handles CREATE TABLE + ALTER TABLE ADD COLUMN + CREATE INDEX together", () => {
    const sql = `
      CREATE TABLE products (id SERIAL PRIMARY KEY, name VARCHAR(200));
      ALTER TABLE products ADD COLUMN price DECIMAL(10,2);
      ALTER TABLE products ADD COLUMN category VARCHAR(50);
      CREATE INDEX idx_products_category ON products (category);
    `;
    const migration = parseMigration("V5__products_table.sql", sql);
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.statements.length).toBe(4);
    // Reverse order: index, category col, price col, table
    expect(report.statements[0].rollback).toContain("DROP INDEX");
    expect(report.statements[0].rollback).toContain("idx_products_category");
    expect(report.statements[1].rollback).toContain("DROP COLUMN IF EXISTS category");
    expect(report.statements[2].rollback).toContain("DROP COLUMN IF EXISTS price");
    expect(report.statements[3].rollback).toContain("DROP TABLE IF EXISTS products");
  });

  it("handles migration with ONLY irreversible operations", () => {
    const sql = `
      DROP TABLE old_users;
      ALTER TABLE orders DROP COLUMN legacy_status;
      DROP INDEX idx_old_index;
    `;
    const migration = parseMigration("V12__cleanup_legacy.sql", sql);
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.length).toBe(3);
    expect(report.statements.every(s => !s.isReversible)).toBe(true);
    expect(report.rollbackSql).toContain("NOT fully reversible");
    expect(report.rollbackSql).toContain("manual intervention");
  });

  it("handles mixed reversible and irreversible operations", () => {
    const sql = `
      CREATE TABLE audit_log (id SERIAL PRIMARY KEY, action TEXT, created_at TIMESTAMP);
      ALTER TABLE users DROP COLUMN old_password;
      ALTER TABLE users ADD COLUMN password_hash VARCHAR(255);
      CREATE INDEX idx_audit_created ON audit_log (created_at);
    `;
    const migration = parseMigration("V15__security_update.sql", sql);
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(false);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain("old_password");
    // 3 of 4 should be reversible
    const reversible = report.statements.filter(s => s.isReversible);
    expect(reversible.length).toBe(3);
  });

  it("handles CREATE TABLE + ADD CONSTRAINT with FK", () => {
    const sql = `
      CREATE TABLE categories (id SERIAL PRIMARY KEY, name VARCHAR(100));
      CREATE TABLE products (id SERIAL PRIMARY KEY, category_id INT, name VARCHAR(200));
      ALTER TABLE products ADD CONSTRAINT fk_product_category FOREIGN KEY (category_id) REFERENCES categories(id);
    `;
    const migration = parseMigration("V20__categories.sql", sql);
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    // Reverse order: FK first, then products, then categories
    expect(report.statements[0].rollback).toContain("DROP CONSTRAINT IF EXISTS fk_product_category");
    expect(report.statements[1].rollback).toContain("DROP TABLE IF EXISTS products");
    expect(report.statements[2].rollback).toContain("DROP TABLE IF EXISTS categories");
  });

  it("handles RENAME TABLE and RENAME COLUMN in same migration", () => {
    const sql = `
      ALTER TABLE users RENAME TO customers;
      ALTER TABLE customers RENAME COLUMN name TO full_name;
    `;
    const migration = parseMigration("V25__rename_users.sql", sql);
    const report = generateRollback(migration);
    // Both renames should be reversible
    const reversible = report.statements.filter(s => s.isReversible);
    expect(reversible.length).toBe(2);
    // Reverse order: column rename first, then table rename
    expect(report.statements[0].rollback).toContain("RENAME COLUMN full_name TO name");
    expect(report.statements[1].rollback).toContain("RENAME TO users");
  });

  it("handles SET NOT NULL rollback correctly", () => {
    const sql = `
      ALTER TABLE users ALTER COLUMN email SET NOT NULL;
      ALTER TABLE users ADD COLUMN verified BOOLEAN;
    `;
    const migration = parseMigration("V30__nullability.sql", sql);
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.statements.length).toBe(2);
    // Reverse order: ADD COLUMN rollback first, then SET NOT NULL rollback
    expect(report.statements[0].rollback).toContain("DROP COLUMN IF EXISTS verified");
    expect(report.statements[1].rollback).toContain("DROP NOT NULL");
  });

  it("handles large migration with many statements in correct reverse order", () => {
    const stmts = [];
    for (let i = 0; i < 10; i++) {
      stmts.push(`ALTER TABLE users ADD COLUMN field_${i} VARCHAR(100)`);
    }
    const sql = stmts.join(";\n") + ";";
    const migration = parseMigration("V40__many_columns.sql", sql);
    const report = generateRollback(migration);
    expect(report.fullyReversible).toBe(true);
    expect(report.statements.length).toBe(10);
    // First rollback should be for the last column added (field_9)
    expect(report.statements[0].rollback).toContain("field_9");
    // Last rollback should be for the first column added (field_0)
    expect(report.statements[9].rollback).toContain("field_0");
  });

  it("generates correct rollback SQL header for non-Flyway filenames", () => {
    const sql = "CREATE TABLE temp (id INT);";
    const migration = parseMigration("not-a-flyway-name.sql", sql);
    const report = generateRollback(migration);
    expect(report.rollbackSql).toContain("Rollback migration: not-a-flyway-name.sql");
    // No version line since it's not a versioned migration
    expect(report.rollbackSql).not.toContain("Reverses version:");
    // No Flyway cleanup since no version
    expect(report.rollbackSql).not.toContain("flyway_schema_history");
  });
});
