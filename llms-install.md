# Install mcp-migration-advisor via Cline

Run in Cline terminal:

```bash
npx -y mcp-migration-advisor
```

# Configuration

No environment variables required. Provide migration file paths or raw SQL/XML/YAML content inline when prompting.

Add to your MCP client config:

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

Supports Flyway SQL migrations and Liquibase XML/YAML changelogs. Analysis is static — no database connection required.
