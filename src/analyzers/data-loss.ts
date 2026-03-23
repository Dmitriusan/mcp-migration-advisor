/**
 * Data loss detector.
 *
 * Detects migration operations that can cause irreversible data loss:
 * - Column drops
 * - Type changes that truncate data
 * - NOT NULL on existing columns without default
 * - Table drops
 * - CASCADE operations
 */

import type { ParsedMigration } from "../parsers/flyway-sql.js";

export type DataLossRisk = "CERTAIN" | "LIKELY" | "POSSIBLE" | "NONE";

export interface DataLossIssue {
  risk: DataLossRisk;
  statement: string;
  tableName: string | null;
  description: string;
  mitigation: string;
}

/**
 * Analyze a migration for data loss risks.
 */
export function analyzeDataLoss(migration: ParsedMigration): DataLossIssue[] {
  const issues: DataLossIssue[] = [];

  for (const stmt of migration.statements) {
    const upper = stmt.raw.toUpperCase();

    switch (stmt.type) {
      case "DROP_COLUMN": {
        issues.push({
          risk: "CERTAIN",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          description: `Dropping column '${stmt.columnName}' permanently deletes all data in that column.`,
          mitigation: "Back up the column data before dropping. Consider renaming the column first and dropping in a later migration after verifying no rollback is needed.",
        });
        break;
      }

      case "DROP_TABLE": {
        const cascade = upper.includes("CASCADE");
        issues.push({
          risk: "CERTAIN",
          statement: truncate(stmt.raw),
          tableName: stmt.tableName,
          description: `Dropping table '${stmt.tableName}' permanently deletes all data.${cascade ? " CASCADE will also drop dependent objects." : ""}`,
          mitigation: "Ensure a backup exists. Consider renaming the table first and dropping in a later migration.",
        });
        break;
      }

      case "MODIFY_COLUMN": {
        if (stmt.details.typeChange === "true") {
          // Try to detect narrowing type changes
          const typeChangeMatch = stmt.raw.match(/(?:TYPE|SET DATA TYPE)\s+(\w+(?:\(\d+(?:,\s*\d+)?\))?)/i);
          const newType = typeChangeMatch?.[1]?.toUpperCase() || "UNKNOWN";

          issues.push({
            risk: "LIKELY",
            statement: truncate(stmt.raw),
            tableName: stmt.tableName,
            description: `Changing type of '${stmt.columnName}' to ${newType} may truncate or lose data if existing values don't fit the new type.`,
            mitigation: "Run a SELECT to verify all existing values are compatible with the new type before migrating. Use a USING clause for explicit conversion.",
          });
        }

        if (stmt.details.setNotNull === "true") {
          issues.push({
            risk: "POSSIBLE",
            statement: truncate(stmt.raw),
            tableName: stmt.tableName,
            description: `SET NOT NULL on '${stmt.columnName}' will fail if any NULL values exist, blocking the migration.`,
            mitigation: "Run UPDATE ... SET column = default_value WHERE column IS NULL before adding the NOT NULL constraint.",
          });
        }
        break;
      }

      case "ADD_COLUMN": {
        if (stmt.details.notNull === "true" && stmt.details.hasDefault !== "true") {
          issues.push({
            risk: "POSSIBLE",
            statement: truncate(stmt.raw),
            tableName: stmt.tableName,
            description: `Adding NOT NULL column '${stmt.columnName}' without DEFAULT will fail on tables with existing rows.`,
            mitigation: "Add a DEFAULT value, or add the column as nullable first, backfill, then set NOT NULL.",
          });
        }
        break;
      }

      case "OTHER": {
        // Detect TRUNCATE
        if (upper.includes("TRUNCATE")) {
          const tableMatch = stmt.raw.match(/TRUNCATE\s+(?:TABLE\s+)?(?:`|"|)?(?:\w+\.)?(\w+)/i);
          issues.push({
            risk: "CERTAIN",
            statement: truncate(stmt.raw),
            tableName: tableMatch?.[1] || null,
            description: "TRUNCATE permanently deletes all rows from the table.",
            mitigation: "Ensure this is intentional. Back up the table data first.",
          });
        }

        // Detect DELETE without WHERE
        if (upper.match(/DELETE\s+FROM/) && !upper.includes("WHERE")) {
          const tableMatch = stmt.raw.match(/DELETE\s+FROM\s+(?:`|"|)?(?:\w+\.)?(\w+)/i);
          issues.push({
            risk: "CERTAIN",
            statement: truncate(stmt.raw),
            tableName: tableMatch?.[1] || null,
            description: "DELETE without WHERE clause deletes all rows from the table.",
            mitigation: "Add a WHERE clause to limit the delete, or use TRUNCATE if intentional.",
          });
        }

        // Detect UPDATE without WHERE
        if (upper.match(/^UPDATE\b/) && !upper.includes("WHERE")) {
          const tableMatch = stmt.raw.match(/UPDATE\s+(?:`|"|)?(?:\w+\.)?(\w+)/i);
          issues.push({
            risk: "LIKELY",
            statement: truncate(stmt.raw),
            tableName: tableMatch?.[1] || null,
            description: "UPDATE without WHERE clause modifies all rows. Previous values are lost.",
            mitigation: "Add a WHERE clause to limit the update scope. Consider adding a backup column or logging old values.",
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return issues;
}

function truncate(s: string, max = 120): string {
  return s.length > max ? s.substring(0, max) + "..." : s;
}
