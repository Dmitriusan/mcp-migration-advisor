#!/usr/bin/env node

/**
 * MCP Migration Advisor — MCP server for database migration risk analysis.
 *
 * Tools:
 *   analyze_migration  — Parse and analyze a SQL migration for risks
 *   score_risk          — Calculate risk score for a migration
 */

import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json") as { version: string };

import { parseMigration, ParsedMigration } from "./parsers/flyway-sql.js";
import { parseLiquibaseXml } from "./parsers/liquibase-xml.js";
import { parseLiquibaseYaml } from "./parsers/liquibase-yaml.js";
import { analyzeLockRisks, calculateRiskScore } from "./analyzers/lock-risk.js";
import { analyzeDataLoss } from "./analyzers/data-loss.js";
import { generateRollback } from "./generators/rollback.js";
import { detectConflicts, formatConflictReport } from "./analyzers/conflicts.js";

/**
 * Format parser warnings into a markdown section.
 * Returns empty string if there are no warnings.
 */
function formatParserWarnings(migration: ParsedMigration): string {
  if (migration.warnings.length === 0) return "";
  let output = "### Parser Warnings\n\n";
  output += `> ${migration.warnings.length} DDL statement(s) could not be fully parsed and were classified as OTHER\n\n`;
  for (const w of migration.warnings) {
    output += `- \`${w.snippet}\`\n`;
  }
  output += "\n";
  return output;
}

// Handle --help
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`mcp-migration-advisor v${packageVersion} — MCP server for database migration risk analysis

Usage:
  mcp-migration-advisor [options]

Options:
  --help, -h   Show this help message

Tools provided:
  analyze_migration        Parse a SQL migration file and detect risks
  analyze_liquibase        Parse a Liquibase XML changelog and detect risks
  analyze_liquibase_yaml   Parse a Liquibase YAML changelog and detect risks
  score_risk               Calculate overall risk score (0-100)
  generate_rollback        Generate reverse DDL to undo a migration
  detect_conflicts         Detect conflicts between two migration files`);
  process.exit(0);
}

const server = new McpServer({
  name: "mcp-migration-advisor",
  version: packageVersion,
});

// Tool 1: analyze_migration
server.tool(
  "analyze_migration",
  "Analyze a SQL migration file for lock risks, data loss potential, and unsafe patterns. Detects: ACCESS EXCLUSIVE locks (DROP TABLE, ADD COLUMN NOT NULL, type changes, CREATE INDEX without CONCURRENTLY), data loss operations (TRUNCATE, DELETE without WHERE, UPDATE without WHERE, DROP COLUMN), and cascade risks. Supports Flyway versioned (V__*.sql) and repeatable (R__*.sql) migrations, as well as plain SQL files.",
  {
    filename: z.string().describe("Migration filename (e.g., V2__add_user_email.sql)"),
    sql: z.string().describe("The SQL content of the migration file"),
  },
  async ({ filename, sql }) => {
    try {
      const migration = parseMigration(filename, sql);
      const lockRisks = analyzeLockRisks(migration);
      const dataLossIssues = analyzeDataLoss(migration);
      const lockScore = calculateRiskScore(lockRisks);
      const dataLossScore = Math.min(
        100,
        dataLossIssues.filter(i => i.risk === "CERTAIN").length * 25 +
        dataLossIssues.filter(i => i.risk === "LIKELY").length * 15 +
        dataLossIssues.filter(i => i.risk === "POSSIBLE").length * 5,
      );
      const riskScore = Math.min(100, lockScore + dataLossScore);

      let output = `## Migration Analysis: ${filename}\n\n`;

      // Migration info
      if (migration.version) {
        output += `**Version**: ${migration.version}\n`;
      }
      output += `**Description**: ${migration.description}\n`;
      output += `**Statements**: ${migration.statements.length}\n`;
      output += `**Risk Score**: ${riskScore}/100${riskScore >= 60 ? " ⚠️ HIGH RISK" : riskScore >= 30 ? " ⚡ MODERATE RISK" : " ✅ LOW RISK"}\n\n`;

      // Statement summary
      output += "### Operations\n\n";
      const typeCounts: Record<string, number> = {};
      for (const stmt of migration.statements) {
        typeCounts[stmt.type] = (typeCounts[stmt.type] || 0) + 1;
      }
      output += "| Operation | Count |\n|-----------|-------|\n";
      for (const [type, count] of Object.entries(typeCounts)) {
        output += `| ${type} | ${count} |\n`;
      }
      output += "\n";

      // Lock risks
      if (lockRisks.length > 0) {
        output += "### Lock Risks\n\n";
        for (const risk of lockRisks) {
          output += `**${risk.severity}**: ${risk.risk}\n`;
          output += `> \`${risk.statement}\`\n`;
          output += `> **Recommendation**: ${risk.recommendation}\n\n`;
        }
      } else {
        output += "### Lock Risks\n\nNo lock risks detected.\n\n";
      }

      // Data loss issues
      if (dataLossIssues.length > 0) {
        output += "### Data Loss Analysis\n\n";
        for (const issue of dataLossIssues) {
          output += `**${issue.risk}**: ${issue.description}\n`;
          output += `> \`${issue.statement}\`\n`;
          output += `> **Mitigation**: ${issue.mitigation}\n\n`;
        }
      } else {
        output += "### Data Loss Analysis\n\nNo data loss risks detected.\n\n";
      }

      output += formatParserWarnings(migration);

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error analyzing migration: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// Tool 2: analyze_liquibase
server.tool(
  "analyze_liquibase",
  "Analyze a Liquibase XML changelog for lock risks, data loss potential, and unsafe patterns. Supports createTable, dropTable, addColumn, dropColumn, modifyDataType, createIndex, addForeignKeyConstraint, renameTable, renameColumn, and more.",
  {
    xml: z.string().describe("The Liquibase XML changelog content"),
  },
  async ({ xml }) => {
    try {
      const migration = parseLiquibaseXml(xml);
      const lockRisks = analyzeLockRisks(migration);
      const dataLossIssues = analyzeDataLoss(migration);
      const lockScore = calculateRiskScore(lockRisks);
      const dataLossScore = Math.min(
        100,
        dataLossIssues.filter(i => i.risk === "CERTAIN").length * 25 +
        dataLossIssues.filter(i => i.risk === "LIKELY").length * 15 +
        dataLossIssues.filter(i => i.risk === "POSSIBLE").length * 5,
      );
      const riskScore = Math.min(100, lockScore + dataLossScore);

      let output = `## Liquibase Changelog Analysis\n\n`;
      output += `**ChangeSets**: ${migration.description}\n`;
      output += `**Statements**: ${migration.statements.length}\n`;
      output += `**Risk Score**: ${riskScore}/100${riskScore >= 60 ? " ⚠️ HIGH RISK" : riskScore >= 30 ? " ⚡ MODERATE RISK" : " ✅ LOW RISK"}\n\n`;

      const typeCounts: Record<string, number> = {};
      for (const stmt of migration.statements) {
        typeCounts[stmt.type] = (typeCounts[stmt.type] || 0) + 1;
      }
      output += "### Operations\n\n| Operation | Count |\n|-----------|-------|\n";
      for (const [type, count] of Object.entries(typeCounts)) {
        output += `| ${type} | ${count} |\n`;
      }
      output += "\n";

      if (lockRisks.length > 0) {
        output += "### Lock Risks\n\n";
        for (const risk of lockRisks) {
          output += `**${risk.severity}**: ${risk.risk}\n`;
          output += `> \`${risk.statement}\`\n`;
          output += `> **Recommendation**: ${risk.recommendation}\n\n`;
        }
      }

      if (dataLossIssues.length > 0) {
        output += "### Data Loss Analysis\n\n";
        for (const issue of dataLossIssues) {
          output += `**${issue.risk}**: ${issue.description}\n`;
          output += `> \`${issue.statement}\`\n`;
          output += `> **Mitigation**: ${issue.mitigation}\n\n`;
        }
      }

      if (lockRisks.length === 0 && dataLossIssues.length === 0) {
        output += "### No risks detected.\n";
      }

      output += formatParserWarnings(migration);

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error analyzing Liquibase changelog: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// Tool 3: analyze_liquibase_yaml
server.tool(
  "analyze_liquibase_yaml",
  "Analyze a Liquibase YAML changelog for lock risks, data loss potential, and unsafe patterns. Supports createTable, dropTable, addColumn, dropColumn, modifyDataType, createIndex, addForeignKeyConstraint, renameTable, renameColumn, and more.",
  {
    yaml: z.string().describe("The Liquibase YAML changelog content"),
  },
  async ({ yaml }) => {
    try {
      const migration = parseLiquibaseYaml(yaml);
      const lockRisks = analyzeLockRisks(migration);
      const dataLossIssues = analyzeDataLoss(migration);
      const lockScore = calculateRiskScore(lockRisks);
      const dataLossScore = Math.min(
        100,
        dataLossIssues.filter(i => i.risk === "CERTAIN").length * 25 +
        dataLossIssues.filter(i => i.risk === "LIKELY").length * 15 +
        dataLossIssues.filter(i => i.risk === "POSSIBLE").length * 5,
      );
      const riskScore = Math.min(100, lockScore + dataLossScore);

      let output = `## Liquibase YAML Changelog Analysis\n\n`;
      output += `**ChangeSets**: ${migration.description}\n`;
      output += `**Statements**: ${migration.statements.length}\n`;
      output += `**Risk Score**: ${riskScore}/100${riskScore >= 60 ? " ⚠️ HIGH RISK" : riskScore >= 30 ? " ⚡ MODERATE RISK" : " ✅ LOW RISK"}\n\n`;

      const typeCounts: Record<string, number> = {};
      for (const stmt of migration.statements) {
        typeCounts[stmt.type] = (typeCounts[stmt.type] || 0) + 1;
      }
      output += "### Operations\n\n| Operation | Count |\n|-----------|-------|\n";
      for (const [type, count] of Object.entries(typeCounts)) {
        output += `| ${type} | ${count} |\n`;
      }
      output += "\n";

      if (lockRisks.length > 0) {
        output += "### Lock Risks\n\n";
        for (const risk of lockRisks) {
          output += `**${risk.severity}**: ${risk.risk}\n`;
          output += `> \`${risk.statement}\`\n`;
          output += `> **Recommendation**: ${risk.recommendation}\n\n`;
        }
      }

      if (dataLossIssues.length > 0) {
        output += "### Data Loss Analysis\n\n";
        for (const issue of dataLossIssues) {
          output += `**${issue.risk}**: ${issue.description}\n`;
          output += `> \`${issue.statement}\`\n`;
          output += `> **Mitigation**: ${issue.mitigation}\n\n`;
        }
      }

      if (lockRisks.length === 0 && dataLossIssues.length === 0) {
        output += "### No risks detected.\n";
      }

      output += formatParserWarnings(migration);

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error analyzing Liquibase YAML changelog: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// Tool 4: score_risk
server.tool(
  "score_risk",
  "Calculate the combined risk score (0-100) for a SQL migration. Aggregates both lock risk severity (ACCESS EXCLUSIVE, SHARE locks) and data loss potential (DROP, TRUNCATE, type changes) into a single score. Useful for CI gates and automated migration review pipelines.",
  {
    filename: z.string().describe("Migration filename"),
    sql: z.string().describe("The SQL content of the migration file"),
  },
  async ({ filename, sql }) => {
    try {
      const migration = parseMigration(filename, sql);
      const lockRisks = analyzeLockRisks(migration);
      const dataLossIssues = analyzeDataLoss(migration);
      const riskScore = calculateRiskScore(lockRisks);

      const criticalCount = lockRisks.filter(r => r.severity === "CRITICAL").length;
      const highCount = lockRisks.filter(r => r.severity === "HIGH").length;
      const mediumCount = lockRisks.filter(r => r.severity === "MEDIUM").length;
      const lowCount = lockRisks.filter(r => r.severity === "LOW").length;
      const dataLossCertain = dataLossIssues.filter(i => i.risk === "CERTAIN").length;
      const dataLossLikely = dataLossIssues.filter(i => i.risk === "LIKELY").length;
      const dataLossPossible = dataLossIssues.filter(i => i.risk === "POSSIBLE").length;

      // Combine lock risk score with data loss severity for a complete picture
      const dataLossScore = Math.min(100, dataLossCertain * 25 + dataLossLikely * 15 + dataLossPossible * 5);
      const combinedScore = Math.min(100, riskScore + dataLossScore);

      let verdict: string;
      if (combinedScore >= 60 || dataLossCertain > 0) {
        verdict = "HIGH RISK — requires careful review and testing before deployment";
      } else if (combinedScore >= 30 || dataLossLikely > 0) {
        verdict = "MODERATE RISK — review lock duration and test on staging";
      } else {
        verdict = "LOW RISK — standard migration, proceed with normal deployment";
      }

      const output = `## Risk Score: ${combinedScore}/100

**Verdict**: ${verdict}

### Breakdown

| Category | Count | Score contribution |
|----------|-------|--------------------|
| CRITICAL lock risks | ${criticalCount} | ${criticalCount * 30} |
| HIGH lock risks | ${highCount} | ${highCount * 20} |
| MEDIUM lock risks | ${mediumCount} | ${mediumCount * 10} |
| LOW lock risks | ${lowCount} | ${lowCount * 5} |
| Certain data loss | ${dataLossCertain} | ${dataLossCertain * 25} |
| Likely data loss | ${dataLossLikely} | ${dataLossLikely * 15} |
| Possible data loss | ${dataLossPossible} | ${dataLossPossible * 5} |
| Total statements | ${migration.statements.length} | — |
`;

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error scoring migration: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// Tool 5: generate_rollback
server.tool(
  "generate_rollback",
  "Generate reverse DDL to undo a SQL migration. Produces rollback SQL with warnings for irreversible operations (DROP TABLE, DROP COLUMN, type changes). Includes Flyway schema_history cleanup.",
  {
    filename: z.string().describe("Migration filename (e.g., V2__add_user_email.sql)"),
    sql: z.string().describe("The SQL content of the migration file"),
  },
  async ({ filename, sql }) => {
    try {
      const migration = parseMigration(filename, sql);
      const report = generateRollback(migration);

      let output = `## Rollback Script: ${filename}\n\n`;
      output += `**Reversible**: ${report.fullyReversible ? "Yes — all operations can be automatically reversed" : "Partially — some operations require manual intervention"}\n`;
      output += `**Statements**: ${report.statements.length}\n\n`;

      if (report.warnings.length > 0) {
        output += "### Warnings\n\n";
        for (const w of report.warnings) {
          output += `- ${w}\n`;
        }
        output += "\n";
      }

      output += "### Rollback SQL\n\n```sql\n";
      output += report.rollbackSql;
      output += "\n```\n";

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error generating rollback: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// Tool 6: detect_conflicts
server.tool(
  "detect_conflicts",
  "Detect structural conflicts between two SQL migration files — same-table modifications, same-column changes, lock contention, and drop dependencies. Use this when two migrations touch the same schema objects and you need to know if ordering or concurrent execution matters. Note: only structural conflicts are detected (same table/column); semantic conflicts such as two migrations adding different indexes on the same column are not reported.",
  {
    filename_a: z.string().describe("First migration filename (e.g., V3__add_email.sql)"),
    sql_a: z.string().describe("SQL content of the first migration"),
    filename_b: z.string().describe("Second migration filename (e.g., V4__modify_users.sql)"),
    sql_b: z.string().describe("SQL content of the second migration"),
  },
  async ({ filename_a, sql_a, filename_b, sql_b }) => {
    try {
      const migA = parseMigration(filename_a, sql_a);
      const migB = parseMigration(filename_b, sql_b);
      const report = detectConflicts(migA, migB);
      return { content: [{ type: "text" as const, text: formatConflictReport(report) }] };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error detecting conflicts: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
