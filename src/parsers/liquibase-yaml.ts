/**
 * Liquibase YAML changelog parser.
 *
 * Parses Liquibase YAML changelogs and extracts DDL operations
 * compatible with the same DDLStatement interface used by Flyway and XML.
 */

import { DDLStatement, ParsedMigration, collectParserWarnings } from "./flyway-sql.js";

interface ChangeSetInfo {
  id: string;
  author: string;
  statements: DDLStatement[];
}

/**
 * Parse a Liquibase YAML changelog and extract DDL statements.
 *
 * Supports: createTable, dropTable, addColumn, dropColumn, modifyDataType,
 * addNotNullConstraint, createIndex, dropIndex, addForeignKeyConstraint,
 * dropForeignKeyConstraint, renameTable, renameColumn, sql (raw).
 */
export function parseLiquibaseYaml(yaml: string): ParsedMigration {
  const changeSets = extractChangeSets(yaml);
  const allStatements: DDLStatement[] = [];

  for (const cs of changeSets) {
    allStatements.push(...cs.statements);
  }

  return {
    version: changeSets.length > 0 ? changeSets[0].id : null,
    description: `Liquibase changelog (${changeSets.length} changeSets)`,
    filename: "changelog.yaml",
    isRepeatable: false,
    statements: allStatements,
    warnings: collectParserWarnings(allStatements),
  };
}

function extractChangeSets(yaml: string): ChangeSetInfo[] {
  const results: ChangeSetInfo[] = [];

  // Split into lines for indentation-based parsing
  const lines = yaml.split("\n");

  // Find changeSet blocks by scanning for "- changeSet:" pattern
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const csMatch = line.match(/^(\s*)-\s*changeSet\s*:/);
    if (!csMatch) {
      i++;
      continue;
    }

    const baseIndent = csMatch[1].length;
    // Collect all lines belonging to this changeSet
    const csLines: string[] = [];
    i++;
    while (i < lines.length) {
      const nextLine = lines[i];
      // Empty lines are part of the block
      if (nextLine.trim() === "") {
        csLines.push(nextLine);
        i++;
        continue;
      }
      // Check if we've exited the changeSet block
      const nextIndent = nextLine.search(/\S/);
      if (nextIndent <= baseIndent && nextLine.trim().startsWith("-")) break;
      if (nextIndent <= baseIndent && !nextLine.trim().startsWith("-")) break;
      csLines.push(nextLine);
      i++;
    }

    const csBody = csLines.join("\n");
    const id = extractValue(csBody, "id") || "unknown";
    const author = extractValue(csBody, "author") || "unknown";
    const statements = parseChanges(csBody);
    results.push({ id, author, statements });
  }

  return results;
}

function extractValue(text: string, key: string): string | null {
  // Match key: value or key: "value" (with optional quotes)
  const re = new RegExp(`\\b${key}\\s*:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function parseChanges(csBody: string): DDLStatement[] {
  const statements: DDLStatement[] = [];

  // Find the "changes:" block
  const changesIdx = csBody.indexOf("changes:");
  if (changesIdx === -1) return statements;

  const changesBody = csBody.substring(changesIdx);

  // Parse each change type
  parseCreateTable(changesBody, statements);
  parseDropTable(changesBody, statements);
  parseAddColumn(changesBody, statements);
  parseDropColumn(changesBody, statements);
  parseModifyDataType(changesBody, statements);
  parseAddNotNullConstraint(changesBody, statements);
  parseCreateIndex(changesBody, statements);
  parseDropIndex(changesBody, statements);
  parseAddForeignKeyConstraint(changesBody, statements);
  parseDropForeignKeyConstraint(changesBody, statements);
  parseRenameTable(changesBody, statements);
  parseRenameColumn(changesBody, statements);
  parseRawSql(changesBody, statements);

  return statements;
}

function extractChangeBlock(body: string, changeName: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`-\\s*${changeName}\\s*:`, "g");
  let m;

  while ((m = re.exec(body)) !== null) {
    const startIdx = m.index + m[0].length;
    const blockIndent = body.substring(0, m.index).split("\n").pop()!.search(/\S/);
    const remaining = body.substring(startIdx);
    const lines = remaining.split("\n");
    const blockLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") {
        blockLines.push(line);
        continue;
      }
      const indent = line.search(/\S/);
      // If we hit something at same or lower indent that starts a new change, stop
      if (i > 0 && indent <= blockIndent + 2 && line.trim().startsWith("-")) break;
      if (i > 0 && indent <= blockIndent) break;
      blockLines.push(line);
    }

    blocks.push(blockLines.join("\n"));
  }

  return blocks;
}

function parseCreateTable(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "createTable")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    const columns = extractColumnNames(block);
    const details: Record<string, string> = {};
    if (columns.length > 0) details.columns = columns.join(", ");
    statements.push({
      type: "CREATE_TABLE",
      raw: `createTable: ${tableName}`,
      tableName,
      columnName: null,
      details,
    });
  }
}

function parseDropTable(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "dropTable")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    const details: Record<string, string> = {};
    const cascade = extractValue(block, "cascadeConstraints");
    if (cascade === "true") details.cascade = "true";
    statements.push({
      type: "DROP_TABLE",
      raw: `dropTable: ${tableName}`,
      tableName,
      columnName: null,
      details,
    });
  }
}

function parseAddColumn(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "addColumn")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    // Find column entries
    const colNames = extractColumnEntries(block);
    for (const col of colNames) {
      const details: Record<string, string> = {};
      if (col.type) details.type = col.type;
      if (col.nullable === "false") details.notNull = "true";
      if (col.defaultValue) details.hasDefault = "true";
      statements.push({
        type: "ADD_COLUMN",
        raw: `addColumn: ${tableName}.${col.name}`,
        tableName,
        columnName: col.name,
        details,
      });
    }
  }
}

function parseDropColumn(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "dropColumn")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    const colName = extractValue(block, "columnName") || "unknown";
    statements.push({
      type: "DROP_COLUMN",
      raw: `dropColumn: ${tableName}.${colName}`,
      tableName,
      columnName: colName,
      details: {},
    });
  }
}

function parseModifyDataType(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "modifyDataType")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    const colName = extractValue(block, "columnName") || "unknown";
    const newType = extractValue(block, "newDataType");
    const details: Record<string, string> = { typeChange: "true" };
    if (newType) details.newType = newType;
    statements.push({
      type: "MODIFY_COLUMN",
      raw: `modifyDataType: ${tableName}.${colName}`,
      tableName,
      columnName: colName,
      details,
    });
  }
}

function parseAddNotNullConstraint(
  body: string,
  statements: DDLStatement[]
): void {
  for (const block of extractChangeBlock(body, "addNotNullConstraint")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    const colName = extractValue(block, "columnName") || "unknown";
    const details: Record<string, string> = { setNotNull: "true" };
    const defaultVal = extractValue(block, "defaultNullValue");
    if (defaultVal) details.hasDefault = "true";
    statements.push({
      type: "MODIFY_COLUMN",
      raw: `addNotNullConstraint: ${tableName}.${colName}`,
      tableName,
      columnName: colName,
      details,
    });
  }
}

function parseCreateIndex(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "createIndex")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    const details: Record<string, string> = {};
    if (extractValue(block, "unique") === "true") details.unique = "true";
    statements.push({
      type: "CREATE_INDEX",
      raw: `createIndex: ${tableName}`,
      tableName,
      columnName: null,
      details,
    });
  }
}

function parseDropIndex(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "dropIndex")) {
    const tableName = extractValue(block, "tableName") || null;
    statements.push({
      type: "DROP_INDEX",
      raw: `dropIndex`,
      tableName,
      columnName: null,
      details: {},
    });
  }
}

function parseAddForeignKeyConstraint(
  body: string,
  statements: DDLStatement[]
): void {
  for (const block of extractChangeBlock(body, "addForeignKeyConstraint")) {
    const tableName = extractValue(block, "baseTableName") || "unknown";
    const constraintName =
      extractValue(block, "constraintName") || "unknown";
    statements.push({
      type: "ADD_CONSTRAINT",
      raw: `addForeignKeyConstraint: ${constraintName}`,
      tableName,
      columnName: null,
      details: { constraintName, constraintType: "FOREIGN_KEY" },
    });
  }
}

function parseDropForeignKeyConstraint(
  body: string,
  statements: DDLStatement[]
): void {
  for (const block of extractChangeBlock(body, "dropForeignKeyConstraint")) {
    const tableName = extractValue(block, "baseTableName") || "unknown";
    const constraintName =
      extractValue(block, "constraintName") || "unknown";
    statements.push({
      type: "DROP_CONSTRAINT",
      raw: `dropForeignKeyConstraint: ${constraintName}`,
      tableName,
      columnName: null,
      details: { constraintName },
    });
  }
}

function parseRenameTable(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "renameTable")) {
    const oldName = extractValue(block, "oldTableName");
    const newName = extractValue(block, "newTableName");
    statements.push({
      type: "RENAME",
      raw: `renameTable: ${oldName} -> ${newName}`,
      tableName: oldName || "unknown",
      columnName: null,
      details: { newName: newName || "unknown" },
    });
  }
}

function parseRenameColumn(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "renameColumn")) {
    const tableName = extractValue(block, "tableName") || "unknown";
    const oldName = extractValue(block, "oldColumnName");
    const newName = extractValue(block, "newColumnName");
    statements.push({
      type: "RENAME",
      raw: `renameColumn: ${tableName}.${oldName} -> ${newName}`,
      tableName,
      columnName: oldName || null,
      details: { newName: newName || "unknown" },
    });
  }
}

function parseRawSql(body: string, statements: DDLStatement[]): void {
  for (const block of extractChangeBlock(body, "sql")) {
    // The block content after "- sql:" is the raw SQL
    const sql = block.trim();
    if (sql) {
      statements.push({
        type: "OTHER",
        raw: sql,
        tableName: null,
        columnName: null,
        details: { source: "inline-sql" },
      });
    }
  }
}

interface ColumnEntry {
  name: string;
  type?: string;
  nullable?: string;
  defaultValue?: string;
}

function extractColumnEntries(block: string): ColumnEntry[] {
  const columns: ColumnEntry[] = [];
  // Find "- column:" blocks
  const colRe = /-\s*column\s*:/g;
  let m;

  const lines = block.split("\n");
  let lineIdx = 0;

  while (lineIdx < lines.length) {
    const line = lines[lineIdx];
    if (!line.match(/-\s*column\s*:/)) {
      lineIdx++;
      continue;
    }

    // Collect column block
    const colIndent = line.search(/\S/);
    const colLines: string[] = [];
    lineIdx++;
    while (lineIdx < lines.length) {
      const next = lines[lineIdx];
      if (next.trim() === "") {
        colLines.push(next);
        lineIdx++;
        continue;
      }
      const nextIndent = next.search(/\S/);
      if (nextIndent <= colIndent) break;
      colLines.push(next);
      lineIdx++;
    }

    const colBody = colLines.join("\n");
    const name = extractValue(colBody, "name");
    if (name) {
      const entry: ColumnEntry = { name };
      const type = extractValue(colBody, "type");
      if (type) entry.type = type;

      // Check constraints block for nullable
      if (colBody.includes("nullable:")) {
        const nullable = extractValue(colBody, "nullable");
        if (nullable) entry.nullable = nullable;
      }

      // Check for default values
      const defaultValue =
        extractValue(colBody, "defaultValue") ||
        extractValue(colBody, "defaultValueNumeric") ||
        extractValue(colBody, "defaultValueBoolean");
      if (defaultValue) entry.defaultValue = defaultValue;

      columns.push(entry);
    }
  }

  return columns;
}

function extractColumnNames(block: string): string[] {
  return extractColumnEntries(block).map((c) => c.name);
}
