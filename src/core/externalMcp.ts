import fs from 'node:fs';
import path from 'node:path';
import { type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../logger.js';

/**
 * Load user-configured external MCP servers from `<dataDir>/mcp.json`, so Zamolxis's agents can use
 * tools beyond the built-in `zamolxis` server - a Windows GUI-automation server, desktop-commander,
 * a database gateway, whatever the user wires up. These merge alongside the in-process `zamolxis`
 * server at query time; an agent opts in by listing the qualified name `mcp__<server>__<tool>` in
 * its `tools` (the engine passes such names through untouched).
 *
 * Format (either key works):
 *   { "servers": { "windows": { "command": "uvx", "args": ["windows-mcp"] } } }
 *   { "mcpServers": { "desktop-commander": { "command": "npx", "args": ["@wonderwhy-er/desktop-commander"] } } }
 *
 * Missing or malformed file -> no external servers (never throws; this is optional configuration).
 */
export function loadExternalMcpServers(dataDir: string): Record<string, McpServerConfig> {
  const file = path.join(dataDir, 'mcp.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const servers = (raw.servers || raw.mcpServers || {}) as Record<string, unknown>;
    const out: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === 'object') out[name] = cfg as McpServerConfig;
    }
    if (Object.keys(out).length) logger.info({ servers: Object.keys(out) }, 'external MCP servers loaded');
    return out;
  } catch {
    return {};
  }
}
