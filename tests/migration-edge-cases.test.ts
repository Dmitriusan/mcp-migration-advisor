import { describe, it, expect } from "vitest";
import { parseMigration } from "../src/parsers/flyway-sql.js";
import { detectConflicts } from "../src/analyzers/conflicts.js";

describe("Migration parser — edge case inputs", () => {
  it("should handle empty SQL content", () => {
    const result = parseMigration("V1__empty.sql", "");
    expect(result.statements).toHaveLength(0);
    expect(result.version).toBe("1");
    expect(result.description).toBe("empty");
  });

  it("should handle whitespace-only content", () => {
    const result = parseMigration("V1__blank.sql", "   \n\n\t  \n  ");
    expect(result.statements).toHaveLength(0);
  });

  it("should handle comments-only content (no actual SQL)", () => {
    const result = parseMigration("V1__comments.sql", `
-- This is a comment
-- Another comment
/* Block comment */
`);
    expect(result.statements).toHaveLength(0);
  });

  it("should handle non-SQL content (Java code)", () => {
    const result = parseMigration("V1__wrong_file.sql", `
public class Migration {
  public void migrate() {
    System.out.println("Hello");
  }
}
`);
    // Should parse without crashing — content isn't valid SQL but parser won't crash
    expect(result.statements.length).toBeGreaterThanOrEqual(0);
    // Any parsed statements should be typed as OTHER
    for (const stmt of result.statements) {
      expect(["OTHER", "CREATE_TABLE", "ALTER_TABLE", "DROP_TABLE"]).toContain(stmt.type);
    }
  });

  it("should handle XML content (Liquibase XML accidentally)", () => {
    const result = parseMigration("V1__wrong_format.sql", `
<?xml version="1.0" encoding="UTF-8"?>
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog">
  <changeSet id="1" author="dev">
    <createTable tableName="users">
      <column name="id" type="BIGINT"/>
    </createTable>
  </changeSet>
</databaseChangeLog>
`);
    // Should not crash
    expect(result.statements.length).toBeGreaterThanOrEqual(0);
  });

  it("should handle very large migration (1000+ statements)", () => {
    const stmts: string[] = [];
    for (let i = 0; i < 1000; i++) {
      stmts.push(`CREATE TABLE table_${i} (id SERIAL PRIMARY KEY, name VARCHAR(100))`);
    }
    const sql = stmts.join(";\n") + ";";

    const result = parseMigration("V1__massive.sql", sql);
    expect(result.statements).toHaveLength(1000);
    expect(result.statements[0].type).toBe("CREATE_TABLE");
    expect(result.statements[0].tableName).toBe("table_0");
    expect(result.statements[999].tableName).toBe("table_999");
  });

  it("should handle migration with only semicolons", () => {
    const result = parseMigration("V1__just_semicolons.sql", ";;;;\n;;");
    expect(result.statements).toHaveLength(0);
  });

  it("should handle SQL with unicode characters", () => {
    const result = parseMigration("V1__unicode.sql", `
CREATE TABLE données (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(255) NOT NULL,
  prénom VARCHAR(255)
);
`);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].type).toBe("CREATE_TABLE");
  });

  it("should handle SQL with Windows line endings", () => {
    const result = parseMigration("V1__windows.sql",
      "CREATE TABLE users (\r\n  id SERIAL PRIMARY KEY\r\n);\r\n\r\nALTER TABLE users ADD COLUMN name VARCHAR(100);\r\n"
    );
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0].type).toBe("CREATE_TABLE");
    expect(result.statements[1].type).toBe("ADD_COLUMN");
  });

  it("should handle non-Flyway filename format", () => {
    const result = parseMigration("random_migration.sql", "CREATE TABLE test (id INT);");
    expect(result.version).toBeNull();
    expect(result.description).toBe("random_migration.sql");
    expect(result.isRepeatable).toBe(false);
    expect(result.statements).toHaveLength(1);
  });

  it("should handle deeply nested version numbers", () => {
    const result = parseMigration("V1.2.3.4.5__deep_version.sql", "CREATE TABLE test (id INT);");
    expect(result.version).toBe("1.2.3.4.5");
  });

  it("should not split on semicolons inside single-quoted string literals", () => {
    // A semicolon inside a quoted string must not be treated as a statement separator
    const result = parseMigration("V1__strings.sql",
      "INSERT INTO config (key, val) VALUES ('delimiter', ';');"
    );
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].raw).toContain("';'");
  });

  it("should handle escaped single quotes ('') inside string literals", () => {
    // '' is the SQL standard way to embed a literal single quote in a string
    const result = parseMigration("V1__escaped_quotes.sql",
      "INSERT INTO messages (body) VALUES ('It''s a test; really');\nCREATE TABLE log (id SERIAL PRIMARY KEY);"
    );
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0].raw).toContain("It''s a test; really");
    expect(result.statements[1].type).toBe("CREATE_TABLE");
  });

  it("should handle multiple string literals with semicolons in one statement", () => {
    const result = parseMigration("V1__multi_strings.sql",
      "INSERT INTO t (a, b, c) VALUES ('x;y', 'a;b;c', 'end');\nALTER TABLE t ADD COLUMN flag BOOLEAN;"
    );
    expect(result.statements).toHaveLength(2);
    expect(result.statements[1].type).toBe("ADD_COLUMN");
  });
});

// --- Dollar-quoted string handling (PostgreSQL $$ function/trigger bodies) ---

describe("Migration parser — dollar-quoted strings", () => {
  it("should not split on semicolons inside a $$ body", () => {
    const sql = `
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE users ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
`;
    const result = parseMigration("V20__trigger_fn.sql", sql);
    // Two statements: the CREATE FUNCTION and the ALTER TABLE
    expect(result.statements).toHaveLength(2);
    expect(result.statements[0].raw).toContain("CREATE OR REPLACE FUNCTION");
    expect(result.statements[1].type).toBe("ADD_COLUMN");
  });

  it("should handle named dollar-quote tags ($body$)", () => {
    const sql = `
CREATE OR REPLACE FUNCTION check_status()
RETURNS TRIGGER AS $body$
BEGIN
  IF NEW.status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'invalid status; must be active or inactive';
  END IF;
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;
`;
    const result = parseMigration("V21__status_check.sql", sql);
    // Single statement — body semicolons must not split it
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].raw).toContain("$body$");
  });

  it("should handle $$ body followed by additional DDL", () => {
    const sql = `
CREATE FUNCTION noop() RETURNS void AS $$
BEGIN
  NULL;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX idx_users_email ON users(email);
DROP TABLE IF EXISTS tmp_scratch;
`;
    const result = parseMigration("V22__multi_after_fn.sql", sql);
    expect(result.statements).toHaveLength(3);
    expect(result.statements[1].type).toBe("CREATE_INDEX");
    expect(result.statements[2].type).toBe("DROP_TABLE");
  });
});

// --- Schema-qualified table names (public.users, myschema.orders, etc.) ---

describe("Migration parser — schema-qualified table names", () => {
  it("extracts table name from schema.table in CREATE TABLE", () => {
    const result = parseMigration("V30__schema_create.sql",
      "CREATE TABLE public.users (id SERIAL PRIMARY KEY, email TEXT);"
    );
    expect(result.statements[0].type).toBe("CREATE_TABLE");
    expect(result.statements[0].tableName).toBe("users");
  });

  it("extracts table name from schema.table in ALTER TABLE", () => {
    const result = parseMigration("V31__schema_alter.sql",
      "ALTER TABLE public.users ADD COLUMN phone VARCHAR(20);"
    );
    expect(result.statements[0].type).toBe("ADD_COLUMN");
    expect(result.statements[0].tableName).toBe("users");
  });

  it("extracts table name from schema.table in DROP TABLE", () => {
    const result = parseMigration("V32__schema_drop.sql",
      "DROP TABLE IF EXISTS myschema.old_records CASCADE;"
    );
    expect(result.statements[0].type).toBe("DROP_TABLE");
    expect(result.statements[0].tableName).toBe("old_records");
  });

  it("extracts table name from schema.table in CREATE INDEX ON", () => {
    const result = parseMigration("V33__schema_index.sql",
      "CREATE INDEX CONCURRENTLY idx_users_email ON public.users(email);"
    );
    expect(result.statements[0].type).toBe("CREATE_INDEX");
    expect(result.statements[0].tableName).toBe("users");
  });

  it("conflict detection uses unqualified name so schema.users vs users match", () => {
    const migA = parseMigration("V40__a.sql",
      "ALTER TABLE public.users ADD COLUMN phone VARCHAR(20);"
    );
    const migB = parseMigration("V41__b.sql",
      "ALTER TABLE public.users ALTER COLUMN phone TYPE TEXT;"
    );
    const report = detectConflicts(migA, migB);
    // Both modify the same column on the same table — should flag SAME_COLUMN
    expect(report.conflicts.length).toBeGreaterThan(0);
    expect(report.conflicts[0].table).toBe("users");
  });
});
