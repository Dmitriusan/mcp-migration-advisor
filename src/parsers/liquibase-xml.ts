/**
 * Liquibase XML changelog parser.
 *
 * Parses Liquibase XML changelogs and extracts DDL operations
 * compatible with the same DDLStatement interface used by Flyway.
 */

import { DDLStatement, ParsedMigration } from "./flyway-sql.js";

interface ChangeSetInfo {
  id: string;
  author: string;
  statements: DDLStatement[];
}

/**
 * Parse a Liquibase XML changelog and extract DDL statements.
 *
 * Supports: createTable, dropTable, addColumn, dropColumn, modifyDataType,
 * addNotNullConstraint, createIndex, dropIndex, addForeignKeyConstraint,
 * dropForeignKeyConstraint, renameTable, renameColumn, sql (raw).
 */
export function parseLiquibaseXml(xml: string): ParsedMigration {
  const changeSets = extractChangeSets(xml);
  const allStatements: DDLStatement[] = [];

  for (const cs of changeSets) {
    allStatements.push(...cs.statements);
  }

  return {
    version: changeSets.length > 0 ? changeSets[0].id : null,
    description: `Liquibase changelog (${changeSets.length} changeSets)`,
    filename: "changelog.xml",
    isRepeatable: false,
    statements: allStatements,
  };
}

function extractChangeSets(xml: string): ChangeSetInfo[] {
  const results: ChangeSetInfo[] = [];
  const changeSetRe = /<changeSet\s+([^>]*)>([\s\S]*?)<\/changeSet>/gi;
  let match;

  while ((match = changeSetRe.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];

    const id = extractAttr(attrs, "id") || "unknown";
    const author = extractAttr(attrs, "author") || "unknown";

    const statements = parseChangeSetBody(body);
    results.push({ id, author, statements });
  }

  return results;
}

function extractAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
  const match = attrs.match(re);
  return match ? match[1] : null;
}

function parseChangeSetBody(body: string): DDLStatement[] {
  const statements: DDLStatement[] = [];

  // createTable
  const createTableRe = /<createTable\s+([^>]*)(?:\/>|>([\s\S]*?)<\/createTable>)/gi;
  let m;
  while ((m = createTableRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const columnsBody = m[2] || "";
    const columns = extractColumns(columnsBody);
    const details: Record<string, string> = {};
    if (columns.length > 0) details.columns = columns.join(", ");
    statements.push({
      type: "CREATE_TABLE",
      raw: m[0],
      tableName,
      columnName: null,
      details,
    });
  }

  // dropTable
  const dropTableRe = /<dropTable\s+([^/>]*)\/?>(?:<\/dropTable>)?/gi;
  while ((m = dropTableRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const details: Record<string, string> = {};
    const cascade = extractAttr(m[1], "cascadeConstraints");
    if (cascade === "true") details.cascade = "true";
    statements.push({
      type: "DROP_TABLE",
      raw: m[0],
      tableName,
      columnName: null,
      details,
    });
  }

  // addColumn
  const addColumnRe = /<addColumn\s+([^>]*)>([\s\S]*?)<\/addColumn>/gi;
  while ((m = addColumnRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const columnBody = m[2];
    const colRe = /<column\s+([^/>]*)\/?>(?:<\/column>)?/gi;
    let cm;
    while ((cm = colRe.exec(columnBody)) !== null) {
      const colName = extractAttr(cm[1], "name") || "unknown";
      const details: Record<string, string> = {};
      const colType = extractAttr(cm[1], "type");
      if (colType) details.type = colType;
      // Check for constraints
      if (columnBody.includes("nullable=\"false\"") || cm[0].includes("nullable=\"false\"")) {
        details.notNull = "true";
      }
      if (extractAttr(cm[1], "defaultValue") || extractAttr(cm[1], "defaultValueNumeric") || extractAttr(cm[1], "defaultValueBoolean")) {
        details.hasDefault = "true";
      }
      statements.push({
        type: "ADD_COLUMN",
        raw: cm[0],
        tableName,
        columnName: colName,
        details,
      });
    }
  }

  // dropColumn
  const dropColumnRe = /<dropColumn\s+([^/>]*)\/?>(?:<\/dropColumn>)?/gi;
  while ((m = dropColumnRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const colName = extractAttr(m[1], "columnName") || "unknown";
    statements.push({
      type: "DROP_COLUMN",
      raw: m[0],
      tableName,
      columnName: colName,
      details: {},
    });
  }

  // modifyDataType
  const modifyRe = /<modifyDataType\s+([^/>]*)\/?>(?:<\/modifyDataType>)?/gi;
  while ((m = modifyRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const colName = extractAttr(m[1], "columnName") || "unknown";
    const newType = extractAttr(m[1], "newDataType");
    const details: Record<string, string> = { typeChange: "true" };
    if (newType) details.newType = newType;
    statements.push({
      type: "MODIFY_COLUMN",
      raw: m[0],
      tableName,
      columnName: colName,
      details,
    });
  }

  // addNotNullConstraint
  const addNotNullRe = /<addNotNullConstraint\s+([^/>]*)\/?>(?:<\/addNotNullConstraint>)?/gi;
  while ((m = addNotNullRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const colName = extractAttr(m[1], "columnName") || "unknown";
    const details: Record<string, string> = { setNotNull: "true" };
    const defaultVal = extractAttr(m[1], "defaultNullValue");
    if (defaultVal) details.hasDefault = "true";
    statements.push({
      type: "MODIFY_COLUMN",
      raw: m[0],
      tableName,
      columnName: colName,
      details,
    });
  }

  // createIndex
  const createIndexRe = /<createIndex\s+([^>]*)(?:\/>|>([\s\S]*?)<\/createIndex>)/gi;
  while ((m = createIndexRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const details: Record<string, string> = {};
    if (extractAttr(m[1], "unique") === "true") details.unique = "true";
    // Liquibase doesn't have CONCURRENTLY — it's SQL-level
    statements.push({
      type: "CREATE_INDEX",
      raw: m[0],
      tableName,
      columnName: null,
      details,
    });
  }

  // dropIndex
  const dropIndexRe = /<dropIndex\s+([^/>]*)\/?>(?:<\/dropIndex>)?/gi;
  while ((m = dropIndexRe.exec(body)) !== null) {
    statements.push({
      type: "DROP_INDEX",
      raw: m[0],
      tableName: extractAttr(m[1], "tableName") || null,
      columnName: null,
      details: {},
    });
  }

  // addForeignKeyConstraint
  const addFkRe = /<addForeignKeyConstraint\s+([^/>]*)\/?>(?:<\/addForeignKeyConstraint>)?/gi;
  while ((m = addFkRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "baseTableName") || "unknown";
    const constraintName = extractAttr(m[1], "constraintName") || "unknown";
    statements.push({
      type: "ADD_CONSTRAINT",
      raw: m[0],
      tableName,
      columnName: null,
      details: { constraintName, constraintType: "FOREIGN_KEY" },
    });
  }

  // dropForeignKeyConstraint
  const dropFkRe = /<dropForeignKeyConstraint\s+([^/>]*)\/?>(?:<\/dropForeignKeyConstraint>)?/gi;
  while ((m = dropFkRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "baseTableName") || "unknown";
    const constraintName = extractAttr(m[1], "constraintName") || "unknown";
    statements.push({
      type: "DROP_CONSTRAINT",
      raw: m[0],
      tableName,
      columnName: null,
      details: { constraintName },
    });
  }

  // renameTable
  const renameTableRe = /<renameTable\s+([^/>]*)\/?>(?:<\/renameTable>)?/gi;
  while ((m = renameTableRe.exec(body)) !== null) {
    const oldName = extractAttr(m[1], "oldTableName");
    const newName = extractAttr(m[1], "newTableName");
    statements.push({
      type: "RENAME",
      raw: m[0],
      tableName: oldName || "unknown",
      columnName: null,
      details: { newName: newName || "unknown" },
    });
  }

  // renameColumn
  const renameColRe = /<renameColumn\s+([^/>]*)\/?>(?:<\/renameColumn>)?/gi;
  while ((m = renameColRe.exec(body)) !== null) {
    const tableName = extractAttr(m[1], "tableName") || "unknown";
    const oldName = extractAttr(m[1], "oldColumnName");
    const newName = extractAttr(m[1], "newColumnName");
    statements.push({
      type: "RENAME",
      raw: m[0],
      tableName,
      columnName: oldName || null,
      details: { newName: newName || "unknown" },
    });
  }

  // Raw SQL
  const sqlRe = /<sql>([\s\S]*?)<\/sql>/gi;
  while ((m = sqlRe.exec(body)) !== null) {
    statements.push({
      type: "OTHER",
      raw: m[1].trim(),
      tableName: null,
      columnName: null,
      details: { source: "inline-sql" },
    });
  }

  return statements;
}

function extractColumns(body: string): string[] {
  const cols: string[] = [];
  const colRe = /<column\s+([^/>]*)\/?>(?:<\/column>)?/gi;
  let m;
  while ((m = colRe.exec(body)) !== null) {
    const name = extractAttr(m[1], "name");
    if (name) cols.push(name);
  }
  return cols;
}
