#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DatabaseClient } from './database.js';
import { createTunnel } from 'tunnel-ssh';

// Load .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load .env as fallback — MCP-provided env vars take priority
dotenv.config({ path: path.join(__dirname, '../.env'), override: false });

// Idle timeout: close tunnel after 5 minutes of inactivity
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// SSH Tunnel state
let sshTunnel: { server: any; conn: any } | null = null;
let idleTimer: NodeJS.Timeout | null = null;

// Initialize database client (lazy — pool created on first query)
const dbClient = new DatabaseClient({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'database',
});

async function openTunnel(): Promise<boolean> {
  if (sshTunnel) return true;

  const localPort = parseInt(process.env.SSH_LOCAL_PORT || '33061');

  const tunnelOptions = {
    autoClose: false,
    reconnectOnError: false,
  };

  const serverOptions = {
    port: localPort,
  };

  const sshOptions = {
    host: process.env.SSH_HOST || '',
    port: parseInt(process.env.SSH_PORT || '22'),
    username: process.env.SSH_USER || '',
    privateKey: fs.readFileSync(process.env.SSH_KEY_PATH || ''),
  };

  const forwardOptions = {
    srcAddr: 'localhost',
    srcPort: localPort,
    dstAddr: 'localhost',
    dstPort: 3306,
  };

  try {
    const [server, conn] = await createTunnel(
      tunnelOptions,
      serverOptions,
      sshOptions,
      forwardOptions
    );
    sshTunnel = { server, conn };

    // Clean up if the connection drops unexpectedly
    conn.on('close', () => {
      console.error('SSH connection closed');
      sshTunnel = null;
    });
    conn.on('error', (err: Error) => {
      console.error('SSH connection error:', err.message);
      sshTunnel = null;
    });

    console.error('SSH tunnel opened');
    return true;
  } catch (error: any) {
    console.error('Failed to open SSH tunnel:', error.message);
    return false;
  }
}

async function closeTunnel(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  await dbClient.close();

  if (sshTunnel) {
    try {
      sshTunnel.server.close();
      sshTunnel.conn.end();
    } catch {
      // ignore cleanup errors
    }
    sshTunnel = null;
    console.error('SSH tunnel closed (idle timeout)');
  }
}

function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    closeTunnel();
  }, IDLE_TIMEOUT_MS);
}

// Ensure tunnel is open before running a query, with auto-retry on stale connection
async function ensureConnection(): Promise<void> {
  if (!sshTunnel) {
    const ok = await openTunnel();
    if (!ok) throw new Error('Could not establish SSH tunnel to database server');
  }
}

async function runQuery<T = any>(queryFn: () => Promise<T>): Promise<T> {
  await ensureConnection();
  try {
    const result = await queryFn();
    resetIdleTimer();
    return result;
  } catch (error: any) {
    // If the connection is dead, tear down and retry once
    if (
      error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'PROTOCOL_CONNECTION_LOST' ||
      error.message?.includes('Connection lost')
    ) {
      console.error('Connection lost, reconnecting...');
      await closeTunnel();
      await ensureConnection();
      const result = await queryFn();
      resetIdleTimer();
      return result;
    }
    throw error;
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'voicetext-mysql-mcp',
    version: '1.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'read_query',
        description: 'Execute a read-only SELECT query on the VoiceText database',
        inputSchema: {
          type: 'object',
          properties: {
            sql: {
              type: 'string',
              description: 'SELECT query to execute (read-only)',
            },
          },
          required: ['sql'],
        },
      },
      {
        name: 'list_tables',
        description: 'List all tables in the VoiceText database',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'describe_table',
        description: 'Show the structure/schema of a specific table',
        inputSchema: {
          type: 'object',
          properties: {
            table: {
              type: 'string',
              description: 'Name of the table to describe',
            },
          },
          required: ['table'],
        },
      },
      {
        name: 'connect_db',
        description: 'Test database connection health',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Validate SELECT query
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return trimmed.startsWith('select') || trimmed.startsWith('show') || trimmed.startsWith('describe');
}

// Sanitize table name
function sanitizeTableName(table: string): string {
  return table.replace(/[^a-zA-Z0-9_]/g, '');
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'read_query': {
        const sql = (args as any).sql as string;
        if (!isReadOnlyQuery(sql)) {
          throw new Error('Only SELECT, SHOW, and DESCRIBE queries are allowed');
        }
        const results = await runQuery(() => dbClient.query(sql));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'list_tables': {
        const results = await runQuery(() => dbClient.query('SHOW TABLES'));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'describe_table': {
        const table = (args as any).table as string;
        const sanitized = sanitizeTableName(table);
        const results = await runQuery(() => dbClient.query(`DESCRIBE ${sanitized}`));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'connect_db': {
        // Force reconnect if needed
        await ensureConnection();
        const isConnected = await dbClient.testConnection();
        resetIdleTimer();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                connected: isConnected,
                host: process.env.DB_HOST,
                database: process.env.DB_NAME,
                tunnel: sshTunnel ? 'open' : 'closed',
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
    };
  }
});

// Start server — NO tunnel at startup, connects on-demand
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('VoiceText MySQL MCP server running (tunnel connects on-demand)');

  // Cleanup on exit
  process.on('SIGINT', async () => {
    console.error('Shutting down...');
    await closeTunnel();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
