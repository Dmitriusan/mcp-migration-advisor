/**
 * Migration conflict detector.
 *
 * Given two parsed migrations, detects if they modify the same table/column
 * and could conflict when applied concurrently or in the wrong order.
 *
 * Conflict types:
 * - Same table modification (both ALTER/DROP the same table)
 * - Same column modification (both modify the same column)
 * - Dependent order (one adds a column the other references)
 * - Lock contention (both require exclusive locks on the same table)
 */

import { type DDLStatement, type ParsedMigration } from "../parsers/flyway-sql.js";

export interface Conflict {
  severity: "CRITICAL" | "WARNING" | "INFO";
  type: "SAME_TABLE" | "SAME_COLUMN" | "LOCK_CONTENTION" | "DROP_DEPENDENCY";
  table: string;
  column?: string;
  message: string;
  recommendation: string;
  statementA: string;
  statementB: string;
}

export interface ConflictReport {
  migrationA: string;
  migrationB: string;
  conflicts: Conflict[];
  canRunConcurrently: boolean;
}

// Statement types that take exclusive locks
const EXCLUSIVE_LOCK_TYPES: Set<DDLStatement["type"]> = new Set([
  "ALTER_TABLE",
  "DROP_TABLE",
  "ADD_COLUMN",
  "DROP_COLUMN",
  "MODIFY_COLUMN",
  "ADD_CONSTRAINT",
  "DROP_CONSTRAINT",
  "RENAME",
]);

// Statement types that modify a column
const COLUMN_MODIFYING_TYPES: Set<DDLStatement["type"]> = new Set([
  "ADD_COLUMN",
  "DROP_COLUMN",
  "MODIFY_COLUMN",
]);

export function detectConflicts(
  migrationA: ParsedMigration,
  migrationB: ParsedMigration,
): ConflictReport {
  const conflicts: Conflict[] = [];

  // Build table→statements map for each migration
  const tablesA = groupByTable(migrationA.statements);
  const tablesB = groupByTable(migrationB.statements);

  // Find overlapping tables
  for (const [table, stmtsA] of tablesA) {
    const stmtsB = tablesB.get(table);
    if (!stmtsB) continue;

    // Check for column-level conflicts first (more specific)
    const columnConflicts = detectColumnConflicts(table, stmtsA, stmtsB);
    conflicts.push(...columnConflicts);

    // Check for lock contention (both need exclusive locks on same table)
    const lockA = stmtsA.some((s) => EXCLUSIVE_LOCK_TYPES.has(s.type));
    const lockB = stmtsB.some((s) => EXCLUSIVE_LOCK_TYPES.has(s.type));

    if (lockA && lockB && columnConflicts.length === 0) {
      // Only add table-level conflict if no column-level conflict was found
      conflicts.push({
        severity: "WARNING",
        type: "LOCK_CONTENTION",
        table,
        message: `Both migrations require exclusive locks on table "${table}". Running concurrently may cause lock wait timeouts.`,
        recommendation: `Merge these changes into a single migration or ensure they run sequentially with sufficient lock_timeout.`,
        statementA: truncate(stmtsA[0].raw),
        statementB: truncate(stmtsB[0].raw),
      });
    }

    // Check for drop dependency: one drops a table the other modifies
    const dropsA = stmtsA.filter((s) => s.type === "DROP_TABLE");
    const modifiesB = stmtsB.filter((s) => s.type !== "DROP_TABLE" && s.type !== "CREATE_TABLE");

    if (dropsA.length > 0 && modifiesB.length > 0) {
      conflicts.push({
        severity: "CRITICAL",
        type: "DROP_DEPENDENCY",
        table,
        message: `Migration "${migrationA.filename}" drops table "${table}" while "${migrationB.filename}" modifies it. Order-dependent failure.`,
        recommendation: `Ensure the DROP TABLE migration runs AFTER the other, or consolidate both changes.`,
        statementA: truncate(dropsA[0].raw),
        statementB: truncate(modifiesB[0].raw),
      });
    }

    const dropsB = stmtsB.filter((s) => s.type === "DROP_TABLE");
    const modifiesA = stmtsA.filter((s) => s.type !== "DROP_TABLE" && s.type !== "CREATE_TABLE");

    if (dropsB.length > 0 && modifiesA.length > 0) {
      conflicts.push({
        severity: "CRITICAL",
        type: "DROP_DEPENDENCY",
        table,
        message: `Migration "${migrationB.filename}" drops table "${table}" while "${migrationA.filename}" modifies it. Order-dependent failure.`,
        recommendation: `Ensure the DROP TABLE migration runs AFTER the other, or consolidate both changes.`,
        statementA: truncate(modifiesA[0].raw),
        statementB: truncate(dropsB[0].raw),
      });
    }
  }

  const canRunConcurrently = conflicts.every(
    (c) => c.severity !== "CRITICAL" && c.type !== "LOCK_CONTENTION",
  );

  return {
    migrationA: migrationA.filename,
    migrationB: migrationB.filename,
    conflicts,
    canRunConcurrently,
  };
}

function detectColumnConflicts(
  table: string,
  stmtsA: DDLStatement[],
  stmtsB: DDLStatement[],
): Conflict[] {
  const conflicts: Conflict[] = [];

  const colStmtsA = stmtsA.filter(
    (s) => COLUMN_MODIFYING_TYPES.has(s.type) && s.columnName,
  );
  const colStmtsB = stmtsB.filter(
    (s) => COLUMN_MODIFYING_TYPES.has(s.type) && s.columnName,
  );

  for (const a of colStmtsA) {
    for (const b of colStmtsB) {
      if (
        a.columnName &&
        b.columnName &&
        a.columnName.toLowerCase() === b.columnName.toLowerCase()
      ) {
        conflicts.push({
          severity: "CRITICAL",
          type: "SAME_COLUMN",
          table,
          column: a.columnName,
          message: `Both migrations modify column "${a.columnName}" on table "${table}". This will cause conflicts regardless of execution order.`,
          recommendation: `Merge these column changes into a single migration to avoid conflicts.`,
          statementA: truncate(a.raw),
          statementB: truncate(b.raw),
        });
      }
    }
  }

  return conflicts;
}

function groupByTable(statements: DDLStatement[]): Map<string, DDLStatement[]> {
  const map = new Map<string, DDLStatement[]>();
  for (const stmt of statements) {
    if (!stmt.tableName) continue;
    const table = stmt.tableName.toLowerCase();
    const existing = map.get(table) || [];
    existing.push(stmt);
    map.set(table, existing);
  }
  return map;
}

function truncate(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 3) + "..." : clean;
}

export function formatConflictReport(report: ConflictReport): string {
  const sections: string[] = [];

  sections.push("## Migration Conflict Analysis");
  sections.push(`\n- **Migration A**: ${report.migrationA}`);
  sections.push(`- **Migration B**: ${report.migrationB}`);
  sections.push(`- **Conflicts found**: ${report.conflicts.length}`);
  sections.push(
    `- **Can run concurrently**: ${report.canRunConcurrently ? "Yes" : "**No**"}`,
  );

  if (report.conflicts.length === 0) {
    sections.push(
      "\n### No conflicts detected\n\nThese migrations can safely be applied in either order.",
    );
    return sections.join("\n");
  }

  const critical = report.conflicts.filter((c) => c.severity === "CRITICAL");
  const warnings = report.conflicts.filter((c) => c.severity === "WARNING");

  if (critical.length > 0) {
    sections.push(`\n### Critical Conflicts (${critical.length})\n`);
    for (const c of critical) {
      sections.push(`**[${c.type}]** Table: \`${c.table}\`${c.column ? `, Column: \`${c.column}\`` : ""}`);
      sections.push(c.message);
      sections.push(`- A: \`${c.statementA}\``);
      sections.push(`- B: \`${c.statementB}\``);
      sections.push(`*Fix*: ${c.recommendation}\n`);
    }
  }

  if (warnings.length > 0) {
    sections.push(`\n### Warnings (${warnings.length})\n`);
    for (const c of warnings) {
      sections.push(`**[${c.type}]** Table: \`${c.table}\``);
      sections.push(c.message);
      sections.push(`*Fix*: ${c.recommendation}\n`);
    }
  }

  return sections.join("\n");
}
