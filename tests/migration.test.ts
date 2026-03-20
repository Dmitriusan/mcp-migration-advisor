import { describe, it, expect } from "vitest";
import { parseMigration, parseFlywayFilename } from "../src/parsers/flyway-sql.js";
import { analyzeLockRisks, calculateRiskScore } from "../src/analyzers/lock-risk.js";
import { analyzeDataLoss } from "../src/analyzers/data-loss.js";

// --- Flyway filename parsing ---

describe("parseFlywayFilename", () => {
  it("parses versioned migration", () => {
    const result = parseFlywayFilename("V2__Add_user_table.sql");
    expect(result.version).toBe("2");
    expect(result.description).toBe("Add user table");
    expect(result.isRepeatable).toBe(false);
  });

  it("parses multi-segment version", () => {
    const result = parseFlywayFilename("V1.3.2__Fix_indexes.sql");
    expect(result.version).toBe("1.3.2");
    expect(result.description).toBe("Fix indexes");
  });

  it("parses underscore version separator", () => {
    const result = parseFlywayFilename("V1_3__Something.sql");
    expect(result.version).toBe("1.3");
  });

  it("parses repeatable migration", () => {
    const result = parseFlywayFilename("R__Create_views.sql");
    expect(result.version).toBeNull();
    expect(result.description).toBe("Create views");
    expect(result.isRepeatable).toBe(true);
  });

  it("handles path prefix", () => {
    const result = parseFlywayFilename("/db/migrations/V5__Add_email.sql");
    expect(result.version).toBe("5");
    expect(result.description).toBe("Add email");
  });
});

// --- SQL parsing ---

describe("parseMigration", () => {
  it("parses CREATE TABLE", () => {
    const sql = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL
      );
    `;
    const result = parseMigration("V1__Create_users.sql", sql);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].type).toBe("CREATE_TABLE");
    expect(result.statements[0].tableName).toBe("users");
  });

  it("parses multiple statements", () => {
    const sql = `
      CREATE TABLE orders (id SERIAL PRIMARY KEY);
      CREATE INDEX idx_orders_status ON orders(status);
      ALTER TABLE orders ADD COLUMN total DECIMAL(10,2) NOT NULL DEFAULT 0;
    `;
    const result = parseMigration("V2__Create_orders.sql", sql);
    expect(result.statements).toHaveLength(3);
    expect(result.statements[0].type).toBe("CREATE_TABLE");
    expect(result.statements[1].type).toBe("CREATE_INDEX");
    expect(result.statements[2].type).toBe("ADD_COLUMN");
  });

  it("ignores comments", () => {
    const sql = `
      -- This is a comment
      /* Block comment */
      CREATE TABLE test (id INT);
    `;
    const result = parseMigration("V3__Test.sql", sql);
    expect(result.statements).toHaveLength(1);
  });

  it("detects CREATE INDEX CONCURRENTLY", () => {
    const sql = "CREATE INDEX CONCURRENTLY idx_users_email ON users(email);";
    const result = parseMigration("V4__Add_index.sql", sql);
    expect(result.statements[0].type).toBe("CREATE_INDEX");
    expect(result.statements[0].details.concurrently).toBe("true");
  });

  it("detects ADD COLUMN with NOT NULL", () => {
    const sql = "ALTER TABLE users ADD COLUMN age INTEGER NOT NULL;";
    const result = parseMigration("V5__Add_age.sql", sql);
    expect(result.statements[0].type).toBe("ADD_COLUMN");
    expect(result.statements[0].details.notNull).toBe("true");
    expect(result.statements[0].details.hasDefault).toBeUndefined();
  });

  it("detects ADD COLUMN with NOT NULL and DEFAULT", () => {
    const sql = "ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';";
    const result = parseMigration("V6__Add_status.sql", sql);
    expect(result.statements[0].details.notNull).toBe("true");
    expect(result.statements[0].details.hasDefault).toBe("true");
  });

  it("detects DROP COLUMN", () => {
    const sql = "ALTER TABLE users DROP COLUMN legacy_field;";
    const result = parseMigration("V7__Drop_legacy.sql", sql);
    expect(result.statements[0].type).toBe("DROP_COLUMN");
    expect(result.statements[0].columnName).toBe("legacy_field");
  });

  it("detects column type change", () => {
    const sql = "ALTER TABLE users ALTER COLUMN name TYPE TEXT;";
    const result = parseMigration("V8__Change_type.sql", sql);
    expect(result.statements[0].type).toBe("MODIFY_COLUMN");
    expect(result.statements[0].details.typeChange).toBe("true");
  });

  // --- DROP NOT NULL / SET NOT NULL bug fix (was misclassified as DROP_COLUMN) ---

  it("classifies DROP NOT NULL as MODIFY_COLUMN, not DROP_COLUMN", () => {
    const sql = "ALTER TABLE users ALTER COLUMN email DROP NOT NULL;";
    const result = parseMigration("V50__drop_not_null.sql", sql);
    expect(result.statements[0].type).toBe("MODIFY_COLUMN");
    expect(result.statements[0].columnName).toBe("email");
    expect(result.statements[0].details.dropNotNull).toBe("true");
  });

  it("classifies SET NOT NULL as MODIFY_COLUMN", () => {
    const sql = "ALTER TABLE users ALTER COLUMN email SET NOT NULL;";
    const result = parseMigration("V51__set_not_null.sql", sql);
    expect(result.statements[0].type).toBe("MODIFY_COLUMN");
    expect(result.statements[0].columnName).toBe("email");
    expect(result.statements[0].details.setNotNull).toBe("true");
  });

  it("classifies SET DEFAULT as MODIFY_COLUMN", () => {
    const sql = "ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';";
    const result = parseMigration("V52__set_default.sql", sql);
    expect(result.statements[0].type).toBe("MODIFY_COLUMN");
    expect(result.statements[0].columnName).toBe("status");
    expect(result.statements[0].details.setDefault).toBe("true");
  });

  it("classifies DROP DEFAULT as MODIFY_COLUMN", () => {
    const sql = "ALTER TABLE users ALTER COLUMN status DROP DEFAULT;";
    const result = parseMigration("V53__drop_default.sql", sql);
    expect(result.statements[0].type).toBe("MODIFY_COLUMN");
    expect(result.statements[0].columnName).toBe("status");
    expect(result.statements[0].details.dropDefault).toBe("true");
  });

  it("classifies SET DATA TYPE as MODIFY_COLUMN", () => {
    const sql = "ALTER TABLE users ALTER COLUMN name SET DATA TYPE VARCHAR(500);";
    const result = parseMigration("V54__set_data_type.sql", sql);
    expect(result.statements[0].type).toBe("MODIFY_COLUMN");
    expect(result.statements[0].columnName).toBe("name");
    expect(result.statements[0].details.typeChange).toBe("true");
  });

  it("still correctly classifies DROP COLUMN after the fix", () => {
    const sql = "ALTER TABLE users DROP COLUMN old_field;";
    const result = parseMigration("V55__drop_col.sql", sql);
    expect(result.statements[0].type).toBe("DROP_COLUMN");
    expect(result.statements[0].columnName).toBe("old_field");
  });

  it("still correctly classifies DROP COLUMN IF EXISTS", () => {
    const sql = "ALTER TABLE users DROP COLUMN IF EXISTS old_field;";
    const result = parseMigration("V56__drop_col_if_exists.sql", sql);
    expect(result.statements[0].type).toBe("DROP_COLUMN");
    expect(result.statements[0].columnName).toBe("old_field");
  });

  it("handles mixed ALTER COLUMN and DROP COLUMN in same migration", () => {
    const sql = `
      ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
      ALTER TABLE users DROP COLUMN legacy_field;
      ALTER TABLE users ALTER COLUMN name SET NOT NULL;
    `;
    const result = parseMigration("V57__mixed.sql", sql);
    expect(result.statements).toHaveLength(3);
    expect(result.statements[0].type).toBe("MODIFY_COLUMN");
    expect(result.statements[0].columnName).toBe("email");
    expect(result.statements[0].details.dropNotNull).toBe("true");
    expect(result.statements[1].type).toBe("DROP_COLUMN");
    expect(result.statements[1].columnName).toBe("legacy_field");
    expect(result.statements[2].type).toBe("MODIFY_COLUMN");
    expect(result.statements[2].columnName).toBe("name");
    expect(result.statements[2].details.setNotNull).toBe("true");
  });

  it("detects DROP TABLE CASCADE", () => {
    const sql = "DROP TABLE IF EXISTS old_data CASCADE;";
    const result = parseMigration("V9__Drop_old.sql", sql);
    expect(result.statements[0].type).toBe("DROP_TABLE");
    expect(result.statements[0].details.cascade).toBe("true");
  });

  it("detects ADD CONSTRAINT FOREIGN KEY", () => {
    const sql = "ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);";
    const result = parseMigration("V10__Add_fk.sql", sql);
    expect(result.statements[0].type).toBe("ADD_CONSTRAINT");
    expect(result.statements[0].details.constraintType).toBe("FOREIGN_KEY");
  });
});

// --- Lock risk analysis ---

describe("analyzeLockRisks", () => {
  it("flags NOT NULL without DEFAULT as CRITICAL", () => {
    const sql = "ALTER TABLE users ADD COLUMN age INTEGER NOT NULL;";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "CRITICAL")).toBe(true);
  });

  it("does not flag NOT NULL with DEFAULT", () => {
    const sql = "ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "CRITICAL")).toBe(false);
  });

  it("flags CREATE INDEX without CONCURRENTLY as HIGH", () => {
    const sql = "CREATE INDEX idx_users_email ON users(email);";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "HIGH" && r.risk.includes("SHARE lock"))).toBe(true);
  });

  it("does not flag CREATE INDEX CONCURRENTLY as HIGH", () => {
    const sql = "CREATE INDEX CONCURRENTLY idx_users_email ON users(email);";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "HIGH")).toBe(false);
    expect(risks.some(r => r.severity === "INFO")).toBe(true);
  });

  it("flags DROP TABLE CASCADE as CRITICAL", () => {
    const sql = "DROP TABLE old_data CASCADE;";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    const criticals = risks.filter(r => r.severity === "CRITICAL");
    expect(criticals.length).toBe(1);
    expect(criticals[0].risk).toContain("CASCADE");
  });

  it("flags column type change as CRITICAL", () => {
    const sql = "ALTER TABLE users ALTER COLUMN name TYPE TEXT;";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "CRITICAL" && r.risk.includes("type"))).toBe(true);
  });

  it("flags SET NOT NULL as HIGH", () => {
    const sql = "ALTER TABLE users ALTER COLUMN email SET NOT NULL;";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "HIGH" && r.risk.includes("SET NOT NULL"))).toBe(true);
  });

  it("flags TRUNCATE as HIGH lock risk", () => {
    const sql = "TRUNCATE TABLE sessions;";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "HIGH" && r.risk.includes("TRUNCATE"))).toBe(true);
  });

  it("flags TRUNCATE TABLE (with TABLE keyword) as HIGH lock risk", () => {
    const sql = "TRUNCATE TABLE audit_log;";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    const truncateRisk = risks.find(r => r.risk.includes("TRUNCATE"));
    expect(truncateRisk).toBeDefined();
    expect(truncateRisk?.tableName).toBe("audit_log");
  });
});

// --- Risk score ---

describe("calculateRiskScore", () => {
  it("returns 0 for no risks", () => {
    expect(calculateRiskScore([])).toBe(0);
  });

  it("scores CRITICAL high", () => {
    const sql = "ALTER TABLE users ADD COLUMN x INT NOT NULL;";
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    const score = calculateRiskScore(risks);
    expect(score).toBeGreaterThanOrEqual(30);
  });

  it("caps at 100", () => {
    const sql = `
      ALTER TABLE a ADD COLUMN x INT NOT NULL;
      ALTER TABLE b ADD COLUMN y INT NOT NULL;
      ALTER TABLE c ADD COLUMN z INT NOT NULL;
      ALTER TABLE d ALTER COLUMN w TYPE TEXT;
    `;
    const migration = parseMigration("V1__test.sql", sql);
    const risks = analyzeLockRisks(migration);
    const score = calculateRiskScore(risks);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// --- Data loss detection ---

describe("analyzeDataLoss", () => {
  it("flags DROP COLUMN as CERTAIN data loss", () => {
    const sql = "ALTER TABLE users DROP COLUMN legacy;";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues.some(i => i.risk === "CERTAIN")).toBe(true);
  });

  it("flags DROP TABLE as CERTAIN data loss", () => {
    const sql = "DROP TABLE old_data;";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues.some(i => i.risk === "CERTAIN")).toBe(true);
  });

  it("flags column type change as LIKELY data loss", () => {
    const sql = "ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(50);";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues.some(i => i.risk === "LIKELY")).toBe(true);
  });

  it("flags TRUNCATE as CERTAIN data loss", () => {
    const sql = "TRUNCATE TABLE sessions;";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues.some(i => i.risk === "CERTAIN" && i.description.includes("TRUNCATE"))).toBe(true);
  });

  it("flags DELETE without WHERE as CERTAIN data loss", () => {
    const sql = "DELETE FROM sessions;";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues.some(i => i.risk === "CERTAIN" && i.description.includes("DELETE"))).toBe(true);
  });

  it("flags SET NOT NULL as POSSIBLE issue", () => {
    const sql = "ALTER TABLE users ALTER COLUMN email SET NOT NULL;";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues.some(i => i.risk === "POSSIBLE")).toBe(true);
  });

  it("returns no issues for safe CREATE TABLE", () => {
    const sql = "CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT);";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues).toHaveLength(0);
  });

  it("returns no issues for safe CREATE INDEX CONCURRENTLY", () => {
    const sql = "CREATE INDEX CONCURRENTLY idx_test ON users(email);";
    const migration = parseMigration("V1__test.sql", sql);
    const issues = analyzeDataLoss(migration);
    expect(issues).toHaveLength(0);
  });
});

// --- Integration: full migration analysis ---

describe("full migration analysis", () => {
  it("analyzes a complex risky migration", () => {
    const sql = `
      -- V15: Dangerous migration
      ALTER TABLE users ADD COLUMN phone VARCHAR(20) NOT NULL;
      ALTER TABLE users DROP COLUMN legacy_ssn;
      CREATE INDEX idx_users_phone ON users(phone);
      ALTER TABLE orders ALTER COLUMN total TYPE INTEGER;
      DROP TABLE IF EXISTS temp_data CASCADE;
    `;
    const migration = parseMigration("V15__Dangerous_migration.sql", sql);

    expect(migration.version).toBe("15");
    expect(migration.statements).toHaveLength(5);

    const lockRisks = analyzeLockRisks(migration);
    const dataLossIssues = analyzeDataLoss(migration);
    const score = calculateRiskScore(lockRisks);

    // Should have multiple CRITICAL risks
    expect(lockRisks.filter(r => r.severity === "CRITICAL").length).toBeGreaterThanOrEqual(2);
    // Should have CERTAIN data loss
    expect(dataLossIssues.filter(i => i.risk === "CERTAIN").length).toBeGreaterThanOrEqual(2);
    // Score should be HIGH
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it("analyzes a safe migration", () => {
    const sql = `
      CREATE TABLE audit_log (
        id SERIAL PRIMARY KEY,
        action VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX CONCURRENTLY idx_audit_action ON audit_log(action);
    `;
    const migration = parseMigration("V10__Add_audit.sql", sql);

    const lockRisks = analyzeLockRisks(migration);
    const dataLossIssues = analyzeDataLoss(migration);
    const score = calculateRiskScore(lockRisks);

    expect(lockRisks.filter(r => r.severity === "CRITICAL").length).toBe(0);
    expect(lockRisks.filter(r => r.severity === "HIGH").length).toBe(0);
    expect(dataLossIssues).toHaveLength(0);
    expect(score).toBeLessThan(30);
  });
});
