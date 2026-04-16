import { describe, it, expect } from "vitest";
import { parseLiquibaseYaml } from "../src/parsers/liquibase-yaml.js";
import { analyzeDataLoss } from "../src/analyzers/data-loss.js";

describe("parseLiquibaseYaml", () => {
  it("parses createTable with columns", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "1"
      author: "dev"
      changes:
        - createTable:
            tableName: users
            columns:
              - column:
                  name: id
                  type: bigint
              - column:
                  name: username
                  type: varchar(255)
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("CREATE_TABLE");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].details.columns).toContain("id");
    expect(migration.statements[0].details.columns).toContain("username");
    expect(migration.version).toBe("1");
    expect(migration.description).toContain("1 changeSets");
  });

  it("parses dropTable", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "2"
      author: "dev"
      changes:
        - dropTable:
            tableName: old_table
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("DROP_TABLE");
    expect(migration.statements[0].tableName).toBe("old_table");
  });

  it("parses dropTable with cascadeConstraints", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "3"
      author: "dev"
      changes:
        - dropTable:
            tableName: cascade_table
            cascadeConstraints: true
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements[0].type).toBe("DROP_TABLE");
    expect(migration.statements[0].details.cascade).toBe("true");
  });

  it("parses addColumn", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "4"
      author: "dev"
      changes:
        - addColumn:
            tableName: users
            columns:
              - column:
                  name: email
                  type: varchar(255)
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("ADD_COLUMN");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].columnName).toBe("email");
    expect(migration.statements[0].details.type).toBe("varchar(255)");
  });

  it("parses addColumn with NOT NULL constraint", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "5"
      author: "dev"
      changes:
        - addColumn:
            tableName: users
            columns:
              - column:
                  name: status
                  type: varchar(50)
                  constraints:
                    nullable: false
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements[0].details.notNull).toBe("true");
  });

  it("parses dropColumn", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "6"
      author: "dev"
      changes:
        - dropColumn:
            tableName: users
            columnName: legacy_field
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("DROP_COLUMN");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].columnName).toBe("legacy_field");
  });

  it("parses modifyDataType", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "7"
      author: "dev"
      changes:
        - modifyDataType:
            tableName: users
            columnName: bio
            newDataType: text
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("MODIFY_COLUMN");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].columnName).toBe("bio");
    expect(migration.statements[0].details.typeChange).toBe("true");
    expect(migration.statements[0].details.newType).toBe("text");
  });

  it("parses createIndex with unique flag", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "8"
      author: "dev"
      changes:
        - createIndex:
            tableName: users
            indexName: idx_users_email
            unique: true
            columns:
              - column:
                  name: email
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("CREATE_INDEX");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].details.unique).toBe("true");
  });

  it("parses dropIndex", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "9"
      author: "dev"
      changes:
        - dropIndex:
            tableName: users
            indexName: idx_users_old
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("DROP_INDEX");
  });

  it("parses addForeignKeyConstraint", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "10"
      author: "dev"
      changes:
        - addForeignKeyConstraint:
            baseTableName: orders
            baseColumnNames: user_id
            constraintName: fk_orders_users
            referencedTableName: users
            referencedColumnNames: id
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("ADD_CONSTRAINT");
    expect(migration.statements[0].tableName).toBe("orders");
    expect(migration.statements[0].details.constraintName).toBe("fk_orders_users");
    expect(migration.statements[0].details.constraintType).toBe("FOREIGN_KEY");
  });

  it("parses renameTable", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "11"
      author: "dev"
      changes:
        - renameTable:
            oldTableName: users
            newTableName: accounts
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("RENAME");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].details.newName).toBe("accounts");
  });

  it("parses renameColumn", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "12"
      author: "dev"
      changes:
        - renameColumn:
            tableName: users
            oldColumnName: name
            newColumnName: full_name
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("RENAME");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].columnName).toBe("name");
    expect(migration.statements[0].details.newName).toBe("full_name");
  });

  it("parses addNotNullConstraint", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "13"
      author: "dev"
      changes:
        - addNotNullConstraint:
            tableName: users
            columnName: email
            defaultNullValue: unknown@example.com
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("MODIFY_COLUMN");
    expect(migration.statements[0].details.setNotNull).toBe("true");
    expect(migration.statements[0].details.hasDefault).toBe("true");
  });

  it("parses multiple changeSets", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "1"
      author: "dev"
      changes:
        - createTable:
            tableName: users
            columns:
              - column:
                  name: id
                  type: bigint
  - changeSet:
      id: "2"
      author: "dev"
      changes:
        - addColumn:
            tableName: users
            columns:
              - column:
                  name: email
                  type: varchar(255)
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(2);
    expect(migration.statements[0].type).toBe("CREATE_TABLE");
    expect(migration.statements[1].type).toBe("ADD_COLUMN");
    expect(migration.description).toContain("2 changeSets");
    expect(migration.version).toBe("1"); // first changeSet id
  });

  it("parses empty changelog", () => {
    const yaml = `
databaseChangeLog:
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(0);
    expect(migration.version).toBeNull();
    expect(migration.description).toContain("0 changeSets");
  });

  it("parses raw SQL blocks", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "14"
      author: "dev"
      changes:
        - sql: CREATE VIEW active_users AS SELECT * FROM users WHERE active = true
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("OTHER");
    expect(migration.statements[0].details.source).toBe("inline-sql");
  });

  it("parses dropForeignKeyConstraint", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "15"
      author: "dev"
      changes:
        - dropForeignKeyConstraint:
            baseTableName: orders
            constraintName: fk_orders_users
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("DROP_CONSTRAINT");
    expect(migration.statements[0].tableName).toBe("orders");
    expect(migration.statements[0].details.constraintName).toBe("fk_orders_users");
  });

  it("works with risk analyzers (integration)", () => {
    // This tests that YAML parser output is compatible with the analyzers
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "1"
      author: "dev"
      changes:
        - dropTable:
            tableName: important_data
        - dropColumn:
            tableName: users
            columnName: email
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(2);
    expect(migration.statements[0].type).toBe("DROP_TABLE");
    expect(migration.statements[1].type).toBe("DROP_COLUMN");
    // Both should have the required fields for analyzers
    for (const stmt of migration.statements) {
      expect(stmt).toHaveProperty("type");
      expect(stmt).toHaveProperty("raw");
      expect(stmt).toHaveProperty("tableName");
      expect(stmt).toHaveProperty("columnName");
      expect(stmt).toHaveProperty("details");
    }
  });
});

describe("edge cases", () => {
  it("handles table names with hyphens and underscores", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "edge-1"
      author: "dev"
      changes:
        - createTable:
            tableName: my-hyphenated_table
            columns:
              - column:
                  name: id
                  type: bigint
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements[0].tableName).toBe("my-hyphenated_table");
  });

  it("handles multiple addColumn entries in one changeSet", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "edge-2"
      author: "dev"
      changes:
        - addColumn:
            tableName: users
            columns:
              - column:
                  name: first_name
                  type: varchar(100)
              - column:
                  name: last_name
                  type: varchar(100)
              - column:
                  name: middle_name
                  type: varchar(100)
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(3);
    expect(migration.statements[0].columnName).toBe("first_name");
    expect(migration.statements[1].columnName).toBe("last_name");
    expect(migration.statements[2].columnName).toBe("middle_name");
  });

  it("handles changeSet with no changes block gracefully", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "edge-3"
      author: "dev"
      comment: "This changeSet has no changes"
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.statements).toHaveLength(0);
  });

  it("handles numeric id without quotes", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: 42
      author: admin
      changes:
        - dropTable:
            tableName: temp
`;
    const migration = parseLiquibaseYaml(yaml);
    expect(migration.version).toBe("42");
  });
});

describe("data-loss detection in Liquibase YAML raw SQL blocks", () => {
  it("detects TRUNCATE in an inline sql block", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "dl-1"
      author: "dev"
      changes:
        - sql: TRUNCATE TABLE sessions
`;
    const migration = parseLiquibaseYaml(yaml);
    const issues = analyzeDataLoss(migration);
    expect(issues).toHaveLength(1);
    expect(issues[0].risk).toBe("CERTAIN");
    expect(issues[0].description).toMatch(/TRUNCATE/);
  });

  it("detects DELETE without WHERE in an inline sql block", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "dl-2"
      author: "dev"
      changes:
        - sql: DELETE FROM expired_tokens
`;
    const migration = parseLiquibaseYaml(yaml);
    const issues = analyzeDataLoss(migration);
    expect(issues).toHaveLength(1);
    expect(issues[0].risk).toBe("CERTAIN");
    expect(issues[0].description).toMatch(/DELETE without WHERE/);
  });

  it("does not flag DELETE with WHERE in an inline sql block", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "dl-3"
      author: "dev"
      changes:
        - sql: DELETE FROM expired_tokens WHERE created_at < NOW() - INTERVAL '30 days'
`;
    const migration = parseLiquibaseYaml(yaml);
    const issues = analyzeDataLoss(migration);
    expect(issues).toHaveLength(0);
  });

  it("detects UPDATE without WHERE in an inline sql block", () => {
    const yaml = `
databaseChangeLog:
  - changeSet:
      id: "dl-4"
      author: "dev"
      changes:
        - sql: UPDATE users SET status = 'active'
`;
    const migration = parseLiquibaseYaml(yaml);
    const issues = analyzeDataLoss(migration);
    expect(issues).toHaveLength(1);
    expect(issues[0].risk).toBe("LIKELY");
    expect(issues[0].description).toMatch(/UPDATE without WHERE/);
  });
});
