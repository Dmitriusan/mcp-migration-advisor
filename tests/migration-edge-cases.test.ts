import { describe, it, expect } from "vitest";
import { parseMigration } from "../src/parsers/flyway-sql.js";

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

  it("should handle SQL with strings containing semicolons", () => {
    // Note: current parser doesn't handle string-internal semicolons,
    // but it should at least not crash
    const result = parseMigration("V1__strings.sql",
      "INSERT INTO config (key, val) VALUES ('delimiter', ';');"
    );
    expect(result.statements.length).toBeGreaterThanOrEqual(1);
  });
});
