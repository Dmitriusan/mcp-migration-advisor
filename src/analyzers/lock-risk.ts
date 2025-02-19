/**
 * Lock risk analyzer.
 *
 * Detects DDL operations that acquire heavy table locks in PostgreSQL and MySQL.
 * Each risky pattern has a severity and recommended safe alternative.
 */

import type { DDLStatement, ParsedMigration } from "../parsers/flyway-sql.js";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface LockRisk {
  severity: Severity;
  statement: string;
  tableName: string | null;
  risk: string;
  recommendation: string;
}

/**
 * Analyze a migration for lock-related risks.
 */
export function analyzeLockRisks(migration: ParsedMigration): LockRisk[] {
  const risks: LockRisk[] = [];

  for (const stmt of migration.statements) {
    const stmtRisks = analyzeStatement(stmt);
    risks.push(...stmtRisks);
  }

  return risks;
}

function analyzeStatement(stmt: DDLStatement): LockRisk[] {
  const risks: LockRisk[] = [];
  const upper = stmt.raw.toUpperCase();

  switch (stmt.type) {
    case "ADD_COLUMN": {
      // NOT NULL without DEFAULT requires full table rewrite (PG <11, all MySQL)
      if (stmt.details.notNull === "true" && stmt.details.hasDefault !== "true") {
        risks.push({
          severity: "CRITICAL",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: `Adding NOT NULL column '${stmt.columnName}' without DEFAULT requires a full table rewrite. This acquires an ACCESS EXCLUSIVE lock for the duration of the rewrite.`,
          recommendation: "Add the column with a DEFAULT value first, then backfill, then set NOT NULL. Or use ALTER TABLE ... ADD COLUMN ... DEFAULT ... NOT NULL (PG 11+ is fast for this).",
        });
      }
      break;
    }

    case "DROP_COLUMN": {
      risks.push({
        severity: "HIGH",
        statement: truncate(stmt.raw),
        tableName: stmt.tableName,
        risk: `Dropping column '${stmt.columnName}' acquires ACCESS EXCLUSIVE lock. In PostgreSQL this is fast (metadata only), but in MySQL it rewrites the table.`,
        recommendation: "For PostgreSQL: generally safe but verify no views/functions depend on this column. For MySQL: use pt-online-schema-change or gh-ost for large tables.",
      });
      break;
    }

    case "MODIFY_COLUMN": {
      if (stmt.details.typeChange === "true") {
        risks.push({
          severity: "CRITICAL",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: `Changing column type for '${stmt.columnName}' may require a full table rewrite with ACCESS EXCLUSIVE lock. Duration depends on table size.`,
          recommendation: "Use expand-contract pattern: add new column, backfill with trigger, switch reads, drop old column. Avoids long lock.",
        });
      }
      if (stmt.details.setNotNull === "true") {
        risks.push({
          severity: "HIGH",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: `SET NOT NULL on '${stmt.columnName}' requires a full table scan to verify no nulls exist. Acquires ACCESS EXCLUSIVE lock during scan (PG <12).`,
          recommendation: "In PG 12+, add a CHECK constraint first (NOT VALID), then validate separately. In older PG/MySQL, test on a replica first.",
        });
      }
      break;
    }

    case "CREATE_INDEX": {
      if (stmt.details.concurrently !== "true") {
        risks.push({
          severity: "HIGH",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: "CREATE INDEX without CONCURRENTLY acquires a SHARE lock on the table, blocking all writes for the duration of index creation.",
          recommendation: "Use CREATE INDEX CONCURRENTLY to allow concurrent writes. Note: CONCURRENTLY cannot run inside a transaction block.",
        });
      } else {
        risks.push({
          severity: "INFO",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: "CREATE INDEX CONCURRENTLY is used — good practice. Note: it takes longer and cannot run in a transaction.",
          recommendation: "Ensure the migration tool runs this outside a transaction (Flyway: use non-transactional migration).",
        });
      }
      break;
    }

    case "DROP_TABLE": {
      risks.push({
        severity: "HIGH",
        statement: truncate(stmt.raw),
        tableName: stmt.tableName,
        risk: `DROP TABLE '${stmt.tableName}' is irreversible and acquires ACCESS EXCLUSIVE lock.`,
        recommendation: "Ensure no foreign keys reference this table. Consider renaming first (expand-contract) to allow rollback.",
      });
      if (stmt.details.cascade === "true") {
        risks.push({
          severity: "CRITICAL",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: "CASCADE will drop all dependent objects (views, foreign keys, functions). This can have unexpected blast radius.",
          recommendation: "List all dependencies first with pg_depend/information_schema. Drop them explicitly instead of using CASCADE.",
        });
      }
      break;
    }

    case "ADD_CONSTRAINT": {
      if (stmt.details.constraintType === "FOREIGN_KEY") {
        risks.push({
          severity: "MEDIUM",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: "Adding a FOREIGN KEY constraint acquires SHARE ROW EXCLUSIVE lock on both tables and validates all existing rows.",
          recommendation: "In PostgreSQL, add the constraint as NOT VALID first, then VALIDATE separately. This splits the lock into two shorter windows.",
        });
      }
      if (upper.includes("NOT VALID")) {
        risks.push({
          severity: "INFO",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          risk: "NOT VALID constraint added — good practice. Constraint is not validated against existing rows.",
          recommendation: "Remember to run ALTER TABLE ... VALIDATE CONSTRAINT in a follow-up migration.",
        });
      }
      break;
    }

    case "RENAME": {
      risks.push({
        severity: "MEDIUM",
        statement: truncate(stmt.raw),
        tableName: stmt.tableName,
        risk: "RENAME acquires ACCESS EXCLUSIVE lock (brief). Application code referencing the old name will break immediately.",
        recommendation: "Coordinate with application deployment. Consider using views as aliases during transition.",
      });
      break;
    }

    default:
      break;
  }

  // Generic checks across all statements
  if (upper.includes("LOCK TABLE") || upper.includes("LOCK TABLES")) {
    risks.push({
      severity: "CRITICAL",
      statement: truncate(stmt.raw),
      tableName: stmt.tableName,
      risk: "Explicit table lock detected. This blocks all concurrent access.",
      recommendation: "Avoid explicit locks in migrations. Use row-level locking or redesign the migration.",
    });
  }

  return risks;
}

function truncate(s: string, max = 120): string {
  return s.length > max ? s.substring(0, max) + "..." : s;
}

/**
 * Calculate overall risk score (0-100) for a migration.
 */
export function calculateRiskScore(risks: LockRisk[]): number {
  if (risks.length === 0) return 0;

  const weights: Record<Severity, number> = {
    CRITICAL: 30,
    HIGH: 20,
    MEDIUM: 10,
    LOW: 5,
    INFO: 0,
  };

  let score = 0;
  for (const risk of risks) {
    score += weights[risk.severity];
  }

  return Math.min(100, score);
}
