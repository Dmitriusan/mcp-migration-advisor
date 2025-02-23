import { describe, it, expect } from "vitest";
import { parseLiquibaseXml } from "../src/parsers/liquibase-xml.js";
import { analyzeLockRisks } from "../src/analyzers/lock-risk.js";
import { analyzeDataLoss } from "../src/analyzers/data-loss.js";

describe("parseLiquibaseXml", () => {
  it("parses createTable", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="1" author="dev">
        <createTable tableName="users">
          <column name="id" type="BIGINT" autoIncrement="true"/>
          <column name="name" type="VARCHAR(255)"/>
          <column name="email" type="VARCHAR(255)"/>
        </createTable>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("CREATE_TABLE");
    expect(migration.statements[0].tableName).toBe("users");
  });

  it("parses dropTable with cascade", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="2" author="dev">
        <dropTable tableName="old_users" cascadeConstraints="true"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("DROP_TABLE");
    expect(migration.statements[0].details.cascade).toBe("true");
  });

  it("parses addColumn with NOT NULL", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="3" author="dev">
        <addColumn tableName="users">
          <column name="status" type="VARCHAR(50)" defaultValue="active">
            <constraints nullable="false"/>
          </column>
        </addColumn>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("ADD_COLUMN");
    expect(migration.statements[0].columnName).toBe("status");
    expect(migration.statements[0].details.notNull).toBe("true");
  });

  it("parses dropColumn", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="4" author="dev">
        <dropColumn tableName="users" columnName="legacy_field"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("DROP_COLUMN");
    expect(migration.statements[0].columnName).toBe("legacy_field");
  });

  it("parses modifyDataType", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="5" author="dev">
        <modifyDataType tableName="orders" columnName="total" newDataType="DECIMAL(12,2)"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("MODIFY_COLUMN");
    expect(migration.statements[0].details.typeChange).toBe("true");
    expect(migration.statements[0].details.newType).toBe("DECIMAL(12,2)");
  });

  it("parses addNotNullConstraint", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="6" author="dev">
        <addNotNullConstraint tableName="users" columnName="email"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("MODIFY_COLUMN");
    expect(migration.statements[0].details.setNotNull).toBe("true");
  });

  it("parses createIndex", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="7" author="dev">
        <createIndex tableName="orders" indexName="idx_orders_user" unique="true">
          <column name="user_id"/>
        </createIndex>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("CREATE_INDEX");
    expect(migration.statements[0].details.unique).toBe("true");
  });

  it("parses addForeignKeyConstraint", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="8" author="dev">
        <addForeignKeyConstraint baseTableName="orders" constraintName="fk_orders_user"
          baseColumnNames="user_id" referencedTableName="users" referencedColumnNames="id"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("ADD_CONSTRAINT");
    expect(migration.statements[0].details.constraintType).toBe("FOREIGN_KEY");
  });

  it("parses renameTable", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="9" author="dev">
        <renameTable oldTableName="users" newTableName="app_users"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(1);
    expect(migration.statements[0].type).toBe("RENAME");
    expect(migration.statements[0].tableName).toBe("users");
    expect(migration.statements[0].details.newName).toBe("app_users");
  });

  it("parses multiple changeSets", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="1" author="dev">
        <createTable tableName="orders">
          <column name="id" type="BIGINT"/>
        </createTable>
      </changeSet>
      <changeSet id="2" author="dev">
        <addColumn tableName="orders">
          <column name="total" type="DECIMAL(10,2)"/>
        </addColumn>
      </changeSet>
      <changeSet id="3" author="dev">
        <createIndex tableName="orders" indexName="idx_orders_total">
          <column name="total"/>
        </createIndex>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(3);
    expect(migration.version).toBe("1"); // first changeSet id
  });

  it("handles empty changelog", () => {
    const xml = `<databaseChangeLog></databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    expect(migration.statements).toHaveLength(0);
  });
});

describe("Liquibase risk analysis", () => {
  it("detects lock risk from createIndex without CONCURRENTLY", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="1" author="dev">
        <createIndex tableName="users" indexName="idx_users_email">
          <column name="email"/>
        </createIndex>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    const risks = analyzeLockRisks(migration);
    expect(risks.some(r => r.severity === "HIGH" || r.severity === "CRITICAL")).toBe(true);
  });

  it("detects data loss from dropColumn", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="1" author="dev">
        <dropColumn tableName="users" columnName="email"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    const dataLoss = analyzeDataLoss(migration);
    expect(dataLoss.some(d => d.risk === "CERTAIN")).toBe(true);
  });

  it("detects data loss from dropTable", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="1" author="dev">
        <dropTable tableName="temp_data" cascadeConstraints="true"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    const dataLoss = analyzeDataLoss(migration);
    expect(dataLoss.some(d => d.risk === "CERTAIN")).toBe(true);
  });

  it("detects risk from modifyDataType", () => {
    const xml = `
    <databaseChangeLog>
      <changeSet id="1" author="dev">
        <modifyDataType tableName="orders" columnName="amount" newDataType="INT"/>
      </changeSet>
    </databaseChangeLog>`;
    const migration = parseLiquibaseXml(xml);
    const dataLoss = analyzeDataLoss(migration);
    expect(dataLoss.some(d => d.risk === "LIKELY")).toBe(true);
  });
});
