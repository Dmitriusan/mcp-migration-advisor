# Changelog

All notable changes to MCP Migration Advisor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-03-08

### Added
- `analyze_liquibase_yaml` tool: Liquibase YAML changelog analysis with full risk detection
- Liquibase YAML parser supporting all 13 standard change types (createTable, dropTable, addColumn, dropColumn, modifyDataType, addNotNullConstraint, createIndex, dropIndex, addForeignKeyConstraint, dropForeignKeyConstraint, renameTable, renameColumn, sql)
- 18 new tests for YAML parser

## [0.1.1] - 2026-03-13

### Fixed
- `DROP NOT NULL` misclassification bug: `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` was incorrectly classified as `DROP_COLUMN` (capturing "NOT" as column name). Fixed by reordering parser checks.

### Added
- `SET DEFAULT` and `DROP DEFAULT` detection in ALTER COLUMN statements
- 8 new parser tests for ALTER COLUMN edge cases

## [0.1.0] - 2026-03-08

### Added
- MCP server for database migration risk analysis
- Flyway SQL parser (V__*.sql and R__*.sql)
- Liquibase XML changelog parser (createTable, dropTable, addColumn, dropColumn, modifyDataType, addNotNullConstraint, createIndex, dropIndex, addFK, dropFK, renameTable, renameColumn, raw SQL)
- Lock risk analyzer detecting ACCESS EXCLUSIVE locks, SHARE locks
- Data loss detector (DROP COLUMN, DROP TABLE, type changes, TRUNCATE, DELETE without WHERE)
- Risk scoring 0-100
- 3 MCP tools: analyze_migration, analyze_liquibase, score_risk
