# MySQL MCP Server

A read-only MySQL MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that connects to remote databases over an SSH tunnel. The tunnel opens on-demand and closes automatically after 5 minutes of inactivity.

## Features

- **Read-only queries** — Only SELECT, SHOW, and DESCRIBE are allowed
- **SSH tunnel** — Connects securely to remote databases through SSH
- **On-demand connection** — Tunnel opens only when a query is made, closes after 5 min idle
- **Auto-reconnect** — Retries automatically if the connection drops mid-query
- **Zero credentials in code** — All configuration via environment variables

## Setup

### 1. Install

```bash
git clone https://github.com/valcicivo/mysql-mcp.git
cd mysql-mcp
npm install
npm run build
```

### 2. Add to Claude Code

```bash
claude mcp add mysql-db node /path/to/mysql-mcp/dist/index.js \
  -e DB_HOST=localhost \
  -e DB_PORT=33061 \
  -e DB_USER=your_db_user \
  -e DB_PASSWORD=your_db_password \
  -e DB_NAME=your_database \
  -e SSH_HOST=your-server.com \
  -e SSH_PORT=22 \
  -e SSH_USER=your_ssh_user \
  -e SSH_KEY_PATH=/path/to/your/ssh_key \
  -e SSH_LOCAL_PORT=33061
```

Or create a `.env` file in the project root (see `.env.example`). MCP env vars take priority over `.env`.

### 3. Use multiple databases

Add separate MCP servers for each database — same code, different env vars:

```bash
claude mcp add production-db node /path/to/mysql-mcp/dist/index.js \
  -e DB_NAME=production_db -e SSH_HOST=prod.example.com ...

claude mcp add staging-db node /path/to/mysql-mcp/dist/index.js \
  -e DB_NAME=staging_db -e SSH_HOST=staging.example.com ...
```

## Available Tools

| Tool | Description |
|------|-------------|
| `read_query(sql)` | Execute a read-only SELECT query |
| `list_tables()` | List all tables in the database |
| `describe_table(table)` | Show the schema of a table |
| `connect_db()` | Test connection health and tunnel status |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_HOST` | No | `localhost` | Database host (relative to SSH server) |
| `DB_PORT` | No | `3306` | Database port (relative to SSH server) |
| `DB_USER` | Yes | — | Database username |
| `DB_PASSWORD` | Yes | — | Database password |
| `DB_NAME` | Yes | — | Database name |
| `SSH_HOST` | Yes | — | SSH server hostname |
| `SSH_PORT` | No | `22` | SSH server port |
| `SSH_USER` | Yes | — | SSH username |
| `SSH_KEY_PATH` | Yes | — | Path to SSH private key |
| `SSH_LOCAL_PORT` | No | `33061` | Local port for the SSH tunnel |

## Security

- Only SELECT, SHOW, and DESCRIBE queries are allowed
- Table names are sanitized to prevent injection
- SSH tunnel is only open while queries are active (5 min idle timeout)
- No credentials stored in code — everything is configured via environment variables
- `.env` file is gitignored

## Development

```bash
npm run watch    # Auto-rebuild on changes
npm run build    # Manual build
```

## License

MIT
