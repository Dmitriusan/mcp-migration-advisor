/**
 * Flyway SQL migration parser.
 *
 * Parses Flyway V__*.sql and R__*.sql migration files.
 * Extracts DDL statements and categorizes operations.
 */

export interface DDLStatement {
  type: "CREATE_TABLE" | "ALTER_TABLE" | "DROP_TABLE" | "CREATE_INDEX" | "DROP_INDEX" |
    "ADD_COLUMN" | "DROP_COLUMN" | "MODIFY_COLUMN" | "ADD_CONSTRAINT" |
    "DROP_CONSTRAINT" | "RENAME" | "OTHER";
  raw: string;
  tableName: string | null;
  columnName: string | null;
  details: Record<string, string>;
}

export interface ParserWarning {
  message: string;
  /** First ~80 characters of the unrecognized statement for debugging */
  snippet: string;
}

export interface ParsedMigration {
  version: string | null;
  description: string;
  filename: string;
  isRepeatable: boolean;
  statements: DDLStatement[];
  warnings: ParserWarning[];
}

const FLYWAY_VERSIONED_RE = /^V(\d+(?:[._]\d+)*)__(.+)\.sql$/i;
const FLYWAY_REPEATABLE_RE = /^R__(.+)\.sql$/i;

/**
 * Parse a Flyway migration filename to extract version and description.
 */
export function parseFlywayFilename(filename: string): { version: string | null; description: string; isRepeatable: boolean } {
  const basename = filename.replace(/^.*[/\\]/, "");
  const vMatch = basename.match(FLYWAY_VERSIONED_RE);
  if (vMatch) {
    return {
      version: vMatch[1].replace(/_/g, "."),
      description: vMatch[2].replace(/_/g, " "),
      isRepeatable: false,
    };
  }
  const rMatch = basename.match(FLYWAY_REPEATABLE_RE);
  if (rMatch) {
    return {
      version: null,
      description: rMatch[1].replace(/_/g, " "),
      isRepeatable: true,
    };
  }
  return { version: null, description: basename, isRepeatable: false };
}

/**
 * Split SQL text into individual statements.
 * Handles semicolons, ignoring those inside string literals and comments.
 * Single-quoted strings are tracked; escaped quotes ('') are handled correctly.
 */
function splitStatements(sql: string): string[] {
  // Remove block comments
  let cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove line comments
  cleaned = cleaned.replace(/--.*$/gm, "");

  const stmts: string[] = [];
  let current = "";
  let inString = false;
  let i = 0;

  while (i < cleaned.length) {
    const char = cleaned[i];

    if (char === "'" && !inString) {
      inString = true;
      current += char;
      i++;
    } else if (char === "'" && inString) {
      current += char;
      i++;
      // '' is the SQL escape for a literal single quote inside a string
      if (i < cleaned.length && cleaned[i] === "'") {
        current += cleaned[i];
        i++;
      } else {
        inString = false;
      }
    } else if (char === ";" && !inString) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        stmts.push(trimmed);
      }
      current = "";
      i++;
    } else {
      current += char;
      i++;
    }
  }

  const last = current.trim();
  if (last.length > 0) {
    stmts.push(last);
  }

  return stmts;
}

// Pattern matchers for DDL statement types
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;
const ALTER_TABLE_RE = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;
const CREATE_INDEX_RE = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:`|"|)?(\w+)(?:`|"|\s).*?\bON\s+(?:`|"|)?(\w+)(?:`|"|)?/i;
const DROP_INDEX_RE = /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;
const ADD_COLUMN_RE = /ADD\s+(?:COLUMN\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;
const DROP_COLUMN_RE = /DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;
const ALTER_COLUMN_RE = /ALTER\s+(?:COLUMN\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;
const ADD_CONSTRAINT_RE = /ADD\s+CONSTRAINT\s+(?:`|"|)?(\w+)(?:`|"|)?/i;
const DROP_CONSTRAINT_RE = /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(?:`|"|)?(\w+)(?:`|"|)?/i;

/**
 * Classify a single SQL statement into a DDLStatement.
 */
function classifyStatement(raw: string): DDLStatement {
  const upper = raw.toUpperCase();
  const details: Record<string, string> = {};

  // CREATE TABLE
  const createTableMatch = raw.match(CREATE_TABLE_RE);
  if (createTableMatch && upper.startsWith("CREATE")) {
    return { type: "CREATE_TABLE", raw, tableName: createTableMatch[1], columnName: null, details };
  }

  // CREATE INDEX
  const createIndexMatch = raw.match(CREATE_INDEX_RE);
  if (createIndexMatch && upper.includes("INDEX")) {
    if (upper.includes("CONCURRENTLY")) {
      details.concurrently = "true";
    }
    if (upper.includes("UNIQUE")) {
      details.unique = "true";
    }
    return { type: "CREATE_INDEX", raw, tableName: createIndexMatch[2], columnName: null, details };
  }

  // DROP TABLE
  const dropTableMatch = raw.match(DROP_TABLE_RE);
  if (dropTableMatch) {
    if (upper.includes("CASCADE")) details.cascade = "true";
    return { type: "DROP_TABLE", raw, tableName: dropTableMatch[1], columnName: null, details };
  }

  // DROP INDEX
  const dropIndexMatch = raw.match(DROP_INDEX_RE);
  if (dropIndexMatch && upper.includes("INDEX")) {
    if (upper.includes("CONCURRENTLY")) details.concurrently = "true";
    return { type: "DROP_INDEX", raw, tableName: null, columnName: null, details };
  }

  // ALTER TABLE with sub-operations
  const alterTableMatch = raw.match(ALTER_TABLE_RE);
  if (alterTableMatch) {
    const tableName = alterTableMatch[1];
    const afterAlter = raw.substring(alterTableMatch[0].length).trim();

    // ADD CONSTRAINT
    const addConstraintMatch = afterAlter.match(ADD_CONSTRAINT_RE);
    if (addConstraintMatch) {
      details.constraintName = addConstraintMatch[1];
      if (upper.includes("FOREIGN KEY")) details.constraintType = "FOREIGN_KEY";
      else if (upper.includes("UNIQUE")) details.constraintType = "UNIQUE";
      else if (upper.includes("CHECK")) details.constraintType = "CHECK";
      else if (upper.includes("PRIMARY KEY")) details.constraintType = "PRIMARY_KEY";
      return { type: "ADD_CONSTRAINT", raw, tableName, columnName: null, details };
    }

    // DROP CONSTRAINT
    const dropConstraintMatch = afterAlter.match(DROP_CONSTRAINT_RE);
    if (dropConstraintMatch) {
      details.constraintName = dropConstraintMatch[1];
      return { type: "DROP_CONSTRAINT", raw, tableName, columnName: null, details };
    }

    // ALTER COLUMN (type change, set not null, drop not null, set default, drop default)
    // Must be checked BEFORE DROP COLUMN — otherwise "ALTER COLUMN x DROP NOT NULL"
    // matches DROP_COLUMN_RE with "NOT" as the column name.
    const alterColMatch = afterAlter.match(ALTER_COLUMN_RE);
    if (alterColMatch && upper.includes("ALTER") && afterAlter.toUpperCase().startsWith("ALTER")) {
      const colName = alterColMatch[1];
      if (upper.includes("SET NOT NULL")) details.setNotNull = "true";
      if (upper.includes("DROP NOT NULL")) details.dropNotNull = "true";
      if (upper.includes("SET DEFAULT")) details.setDefault = "true";
      if (upper.includes("DROP DEFAULT")) details.dropDefault = "true";
      if (upper.includes("TYPE") || upper.includes("SET DATA TYPE")) details.typeChange = "true";
      return { type: "MODIFY_COLUMN", raw, tableName, columnName: colName, details };
    }

    // DROP COLUMN
    const dropColMatch = afterAlter.match(DROP_COLUMN_RE);
    if (dropColMatch && upper.includes("DROP")) {
      return { type: "DROP_COLUMN", raw, tableName, columnName: dropColMatch[1], details };
    }

    // ADD COLUMN
    const addColMatch = afterAlter.match(ADD_COLUMN_RE);
    if (addColMatch && upper.includes("ADD")) {
      const colName = addColMatch[1];
      if (upper.includes("NOT NULL")) details.notNull = "true";
      if (upper.includes("DEFAULT")) details.hasDefault = "true";
      return { type: "ADD_COLUMN", raw, tableName, columnName: colName, details };
    }

    // Generic ALTER TABLE (RENAME, etc.)
    if (upper.includes("RENAME")) {
      return { type: "RENAME", raw, tableName, columnName: null, details };
    }

    return { type: "ALTER_TABLE", raw, tableName, columnName: null, details };
  }

  return { type: "OTHER", raw, tableName: null, columnName: null, details };
}

/**
 * Build a snippet of up to ~80 characters from a raw statement for debugging.
 */
export function truncateSnippet(raw: string, maxLen = 80): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.substring(0, maxLen) + "...";
}

/**
 * Collect warnings for statements classified as OTHER.
 */
export function collectParserWarnings(statements: DDLStatement[]): ParserWarning[] {
  const warnings: ParserWarning[] = [];
  for (const stmt of statements) {
    if (stmt.type === "OTHER") {
      warnings.push({
        message: "Unrecognized DDL statement classified as OTHER",
        snippet: truncateSnippet(stmt.raw),
      });
    }
  }
  return warnings;
}

/**
 * Parse a complete Flyway migration file.
 */
export function parseMigration(filename: string, sql: string): ParsedMigration {
  const { version, description, isRepeatable } = parseFlywayFilename(filename);
  const rawStatements = splitStatements(sql);
  const statements = rawStatements.map(classifyStatement);
  const warnings = collectParserWarnings(statements);

  return {
    version,
    description,
    filename,
    isRepeatable,
    statements,
    warnings,
  };
}
