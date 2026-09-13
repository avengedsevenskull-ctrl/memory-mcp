/**
 * MCP Server
 *
 * Handles Model Context Protocol server initialization and tool registration.
 * Tool definitions and handlers are extracted to separate modules for maintainability.
 *
 * @module server/MCPServer
 */

import { createRequire } from 'node:module';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { logger, type ManagerContext } from '@danielsimonjr/memoryjs';
import { toolDefinitions, toolCategoryMap } from './toolDefinitions.js';
import { handleToolCall } from './toolHandlers.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

/**
 * MCP Server for Knowledge Graph operations.
 * Exposes tools for entity/relation management, search, and analysis.
 */
export class MCPServer {
  private server: Server;
  private ctx: ManagerContext;

  constructor(ctx: ManagerContext) {
    this.ctx = ctx;
    this.server = new Server(
      {
        name: "memory-server",
        version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerToolHandlers();
  }

  private registerToolHandlers() {
    // Register list tools handler with category gating
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const categories = (process.env.MEMORY_TOOL_CATEGORIES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (categories.length === 0 || categories.includes('all')) {
        return { tools: toolDefinitions };
      }
      const allowedNames = new Set<string>();
      for (const cat of categories) {
        const tools = toolCategoryMap[cat];
        if (tools) {
          for (const name of tools) allowedNames.add(name);
        }
      }
      return { tools: toolDefinitions.filter(t => allowedNames.has(t.name)) };
    });

    // Register call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return handleToolCall(name, args || {}, this.ctx);
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Knowledge Graph MCP Server running on stdio');
  }
}
