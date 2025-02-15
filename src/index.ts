#!/usr/bin/env node

/**
 * MCP Migration Advisor — MCP server for database migration risk analysis.
 *
 * Tools:
 *   analyze_migration  — Parse and analyze a SQL migration for risks
 *   score_risk          — Calculate risk score for a migration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { parseMigration } from "./parsers/flyway-sql.js";
import { parseLiquibaseXml } from "./parsers/liquibase-xml.js";
import { parseLiquibaseYaml } from "./parsers/liquibase-yaml.js";
import { analyzeLockRisks, calculateRiskScore } from "./analyzers/lock-risk.js";
import { analyzeDataLoss } from "./analyzers/data-loss.js";
import { generateRollback } from "./generators/rollback.js";
import { detectConflicts, formatConflictReport } from "./analyzers/conflicts.js";
import { validateLicense, formatUpgradePrompt } from "./license.js";

// License check (reads MCP_LICENSE_KEY env var once at startup)
const license = validateLicense(process.env.MCP_LICENSE_KEY, "migration-advisor");

// Handle --help
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`mcp-migration-advisor v0.1.0 — MCP server for database migration risk analysis

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
  version: "0.1.0",
});

// Tool 1: analyze_migration
server.tool(
  "analyze_migration",
  "Analyze a SQL migration file for lock risks, data loss potential, and unsafe patterns. Supports Flyway (V__*.sql) and plain SQL.",
  {
    filename: z.string().describe("Migration filename (e.g., V2__add_user_email.sql)"),
    sql: z.string().describe("The SQL content of the migration file"),
  },
  async ({ filename, sql }) => {
    const migration = parseMigration(filename, sql);
    const lockRisks = analyzeLockRisks(migration);
    const dataLossIssues = analyzeDataLoss(migration);
    const riskScore = calculateRiskScore(lockRisks);

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

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// Tool 2: analyze_liquibase
server.tool(
  "analyze_liquibase",
  "Analyze a Liquibase XML changelog for lock risks, data loss potential, and unsafe patterns.",
  {
    xml: z.string().describe("The Liquibase XML changelog content"),
  },
  async ({ xml }) => {
    const migration = parseLiquibaseXml(xml);
    const lockRisks = analyzeLockRisks(migration);
    const dataLossIssues = analyzeDataLoss(migration);
    const riskScore = calculateRiskScore(lockRisks);

    let output = `## Liquibase Changelog Analysis\n\n`;
    output += `**ChangeSets**: ${migration.description}\n`;
    output += `**Statements**: ${migration.statements.length}\n`;
    output += `**Risk Score**: ${riskScore}/100${riskScore >= 60 ? " HIGH RISK" : riskScore >= 30 ? " MODERATE RISK" : " LOW RISK"}\n\n`;

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
        output += `**${risk.severity}**: ${risk.risk}\n> **Recommendation**: ${risk.recommendation}\n\n`;
      }
    }

    if (dataLossIssues.length > 0) {
      output += "### Data Loss Analysis\n\n";
      for (const issue of dataLossIssues) {
        output += `**${issue.risk}**: ${issue.description}\n> **Mitigation**: ${issue.mitigation}\n\n`;
      }
    }

    if (lockRisks.length === 0 && dataLossIssues.length === 0) {
      output += "### No risks detected.\n";
    }

    return { content: [{ type: "text" as const, text: output }] };
  }
);

// Tool 3: analyze_liquibase_yaml
server.tool(
  "analyze_liquibase_yaml",
  "Analyze a Liquibase YAML changelog for lock risks, data loss potential, and unsafe patterns. Supports createTable, dropTable, addColumn, dropColumn, modifyDataType, createIndex, renameTable, renameColumn, and more.",
  {
    yaml: z.string().describe("The Liquibase YAML changelog content"),
  },
  async ({ yaml }) => {
    const migration = parseLiquibaseYaml(yaml);
    const lockRisks = analyzeLockRisks(migration);
    const dataLossIssues = analyzeDataLoss(migration);
    const riskScore = calculateRiskScore(lockRisks);

    let output = `## Liquibase YAML Changelog Analysis\n\n`;
    output += `**ChangeSets**: ${migration.description}\n`;
    output += `**Statements**: ${migration.statements.length}\n`;
    output += `**Risk Score**: ${riskScore}/100${riskScore >= 60 ? " HIGH RISK" : riskScore >= 30 ? " MODERATE RISK" : " LOW RISK"}\n\n`;

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
        output += `**${risk.severity}**: ${risk.risk}\n> **Recommendation**: ${risk.recommendation}\n\n`;
      }
    }

    if (dataLossIssues.length > 0) {
      output += "### Data Loss Analysis\n\n";
      for (const issue of dataLossIssues) {
        output += `**${issue.risk}**: ${issue.description}\n> **Mitigation**: ${issue.mitigation}\n\n`;
      }
    }

    if (lockRisks.length === 0 && dataLossIssues.length === 0) {
      output += "### No risks detected.\n";
    }

    return { content: [{ type: "text" as const, text: output }] };
  }
);

// Tool 4: score_risk
server.tool(
  "score_risk",
  "Calculate the overall risk score (0-100) for a SQL migration. Higher scores indicate more dangerous migrations.",
  {
    filename: z.string().describe("Migration filename"),
    sql: z.string().describe("The SQL content of the migration file"),
  },
  async ({ filename, sql }) => {
    const migration = parseMigration(filename, sql);
    const lockRisks = analyzeLockRisks(migration);
    const dataLossIssues = analyzeDataLoss(migration);
    const riskScore = calculateRiskScore(lockRisks);

    const criticalCount = lockRisks.filter(r => r.severity === "CRITICAL").length;
    const highCount = lockRisks.filter(r => r.severity === "HIGH").length;
    const dataLossCertain = dataLossIssues.filter(i => i.risk === "CERTAIN").length;
    const dataLossLikely = dataLossIssues.filter(i => i.risk === "LIKELY").length;

    let verdict: string;
    if (riskScore >= 60 || dataLossCertain > 0) {
      verdict = "HIGH RISK — requires careful review and testing before deployment";
    } else if (riskScore >= 30 || dataLossLikely > 0) {
      verdict = "MODERATE RISK — review lock duration and test on staging";
    } else {
      verdict = "LOW RISK — standard migration, proceed with normal deployment";
    }

    const output = `## Risk Score: ${riskScore}/100

**Verdict**: ${verdict}

### Breakdown

| Category | Count |
|----------|-------|
| CRITICAL lock risks | ${criticalCount} |
| HIGH lock risks | ${highCount} |
| Certain data loss | ${dataLossCertain} |
| Likely data loss | ${dataLossLikely} |
| Total statements | ${migration.statements.length} |
`;

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// Tool 4: generate_rollback
server.tool(
  "generate_rollback",
  "Generate reverse DDL to undo a SQL migration. Produces rollback SQL with warnings for irreversible operations (DROP TABLE, DROP COLUMN, type changes). Includes Flyway schema_history cleanup.",
  {
    filename: z.string().describe("Migration filename (e.g., V2__add_user_email.sql)"),
    sql: z.string().describe("The SQL content of the migration file"),
  },
  async ({ filename, sql }) => {
    // Pro feature gate — free users get a preview, Pro users get full output
    if (!license.isPro) {
      const migration = parseMigration(filename, sql);
      const report = generateRollback(migration);

      // Show a preview: statement count and reversibility, but not the actual SQL
      let preview = `## Rollback Preview: ${filename}\n\n`;
      preview += `**Reversible**: ${report.fullyReversible ? "Yes" : "Partially"}\n`;
      preview += `**Statements**: ${report.statements.length}\n`;
      preview += `**Warnings**: ${report.warnings.length}\n\n`;
      preview += formatUpgradePrompt(
        "generate_rollback",
        "Full rollback SQL generation with:\n" +
        "- Complete reverse DDL for all migration operations\n" +
        "- Flyway schema_history cleanup statements\n" +
        "- Irreversibility warnings with manual intervention guidance"
      );

      return { content: [{ type: "text" as const, text: preview }] };
    }

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
  }
);

// Tool 5: detect_conflicts
server.tool(
  "detect_conflicts",
  "Detect conflicts between two SQL migration files. Identifies same-table modifications, same-column changes, lock contention risks, and drop dependencies that could cause failures if applied concurrently or in the wrong order.",
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
