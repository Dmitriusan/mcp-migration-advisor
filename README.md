[![npm version](https://img.shields.io/npm/v/mcp-migration-advisor)](https://www.npmjs.com/package/mcp-migration-advisor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

# MCP Migration Advisor

MCP server for database migration risk analysis. Detects dangerous schema changes before they hit production.

## Why This Tool?

Database migration failures cause outages. This tool analyzes your Flyway and Liquibase migrations **before** they run — detecting destructive operations, lock risks, and data loss patterns.

Unlike MigrationPilot (PG-only, raw SQL analysis), this tool **parses Liquibase XML and YAML changelogs natively** — extracting changeSets, detecting conflicts between changeSet IDs, and validating rollback completeness. It works across database types, not just PostgreSQL.

## Features

- **Lock Risk Analysis**: Detects DDL operations that acquire heavy table locks (ACCESS EXCLUSIVE, SHARE locks)
- **Data Loss Detection**: Finds column drops, type changes that truncate, TRUNCATE/DELETE without WHERE
- **Risk Scoring**: Calculates 0-100 risk score based on severity of detected issues
- **Flyway Support**: Parses V__*.sql and R__*.sql migration filenames
- **Liquibase Support**: Parses XML and YAML changelogs with changeSet extraction
- **Conflict Detection**: Identifies duplicate changeSet IDs and ordering issues
- **Rollback Validation**: Checks rollback completeness for each changeSet
- **Actionable Recommendations**: Every risk includes a specific safe alternative

## Installation

```bash
npx mcp-migration-advisor
```

Or install globally:

```bash
npm install -g mcp-migration-advisor
```

## Claude Desktop Configuration

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "migration-advisor": {
      "command": "npx",
      "args": ["-y", "mcp-migration-advisor"]
    }
  }
}
```

## Quick Demo

Try these prompts in Claude:

1. **"Analyze this migration for risks: ALTER TABLE users DROP COLUMN email;"** — Returns risk score (0-100), lock risks, data loss warnings, and safe alternatives
2. **"Generate a rollback for this migration: CREATE TABLE orders (...); CREATE INDEX idx_orders_user ON orders(user_id);"** — Produces reverse DDL in correct order
3. **"Score this Liquibase changelog: [paste XML]"** — Parses changeSets and calculates overall risk

## Tools

### `analyze_migration`

Full analysis of a SQL migration file. Returns lock risks, data loss analysis, and recommendations.

**Parameters:**
- `filename` — Migration filename (e.g., `V2__add_user_email.sql`)
- `sql` — The SQL content

### `analyze_liquibase`

Full analysis of a Liquibase XML changelog. Parses changeSets and applies the same lock risk and data loss analysis.

**Parameters:**
- `xml` — The Liquibase XML changelog content

### `analyze_liquibase_yaml`

Full analysis of a Liquibase YAML changelog. Parses changeSets from YAML format and applies the same lock risk and data loss analysis. Supports all standard change types: createTable, dropTable, addColumn, dropColumn, modifyDataType, createIndex, renameTable, renameColumn, and more.

**Parameters:**
- `yaml` — The Liquibase YAML changelog content

### `score_risk`

Quick risk score (0-100) with verdict (LOW/MODERATE/HIGH RISK).

**Parameters:**
- `filename` — Migration filename
- `sql` — The SQL content

### `generate_rollback`

Generate reverse DDL to undo a SQL migration. Produces rollback SQL with warnings for irreversible operations.

**Parameters:**
- `filename` — Migration filename
- `sql` — The SQL content

**Reverses automatically:**
- CREATE TABLE → DROP TABLE
- ADD COLUMN → ALTER TABLE ... DROP COLUMN
- CREATE INDEX → DROP INDEX (preserves CONCURRENTLY)
- ADD CONSTRAINT → DROP CONSTRAINT
- SET NOT NULL → DROP NOT NULL
- RENAME → reverse RENAME

**Warns on irreversible:**
- DROP TABLE, DROP COLUMN (data loss)
- Column type changes (original type unknown)
- DROP INDEX, DROP CONSTRAINT (original definition unknown)

Includes Flyway `schema_history` cleanup statement.

### `detect_conflicts`

Detect conflicts between two SQL migration files. Identifies same-table modifications, same-column changes, lock contention risks, and drop dependencies that could cause failures if applied concurrently or in the wrong order.

**Parameters:**
- `filename_a` — First migration filename (e.g., `V3__add_email.sql`)
- `sql_a` — SQL content of the first migration
- `filename_b` — Second migration filename (e.g., `V4__modify_users.sql`)
- `sql_b` — SQL content of the second migration

**Detects:**
- **Same column conflicts** (CRITICAL) — both migrations modify the same column on the same table
- **Drop dependencies** (CRITICAL) — one migration drops a table the other modifies, causing order-dependent failures
- **Lock contention** (WARNING) — both migrations require exclusive locks on the same table, risking lock wait timeouts

Returns a conflict report with severity levels, affected tables/columns, and whether the migrations can safely run concurrently.

## What It Detects

| Pattern | Severity | Why It's Dangerous |
|---------|----------|--------------------|
| NOT NULL without DEFAULT | CRITICAL | Full table rewrite with ACCESS EXCLUSIVE lock |
| Column type change | CRITICAL | Table rewrite, data truncation risk |
| CREATE INDEX (not CONCURRENTLY) | HIGH | SHARE lock blocks all writes |
| DROP TABLE CASCADE | CRITICAL | Drops all dependent objects |
| DROP COLUMN | HIGH | Irreversible data loss |
| SET NOT NULL | HIGH | Full table scan with lock |
| FOREIGN KEY constraint | MEDIUM | Locks both tables for validation |
| TRUNCATE / DELETE without WHERE | CERTAIN data loss | All rows permanently deleted |

## Limitations & Known Issues

- **Static analysis only**: Analyzes SQL text without database connectivity. Cannot check actual table sizes, row counts, or existing schema to calibrate risk.
- **PostgreSQL-focused**: Lock risk recommendations are primarily for PostgreSQL. MySQL and SQLite lock behaviors differ and may not be fully covered.
- **Complex DDL**: Stored procedures, triggers, and dynamic SQL within migrations are classified as "OTHER" and receive generic risk assessment.
- **Liquibase support**: Handles standard XML and YAML changesets. JSON Liquibase format and custom change types are not supported.
- **Rollback limitations**: Auto-generated rollbacks cannot reverse DROP TABLE, DROP COLUMN, or type changes (data is lost). These produce warnings instead of rollback SQL.
- **Multi-statement transactions**: The parser splits on semicolons. Statements containing semicolons inside strings or dollar-quoted blocks may be split incorrectly.
- **No execution**: The advisor analyzes but never executes migrations. All recommendations are advisory.
- **Database-specific DDL**: Parser targets PostgreSQL/MySQL DDL syntax. Oracle PL/SQL or SQL Server T-SQL may not be fully recognized.

## Part of the MCP Java Backend Suite

- [mcp-db-analyzer](https://www.npmjs.com/package/mcp-db-analyzer) — PostgreSQL/MySQL/SQLite schema analysis
- [mcp-spring-boot-actuator](https://www.npmjs.com/package/mcp-spring-boot-actuator) — Spring Boot health, metrics, and bean analysis
- [mcp-jvm-diagnostics](https://www.npmjs.com/package/mcp-jvm-diagnostics) — Thread dump and GC log analysis
- [mcp-redis-diagnostics](https://www.npmjs.com/package/mcp-redis-diagnostics) — Redis memory, slowlog, and client diagnostics

## License

MIT
