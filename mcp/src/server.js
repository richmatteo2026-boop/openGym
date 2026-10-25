/* The MCP server with every tool registered on it. Shared by the stdio entry point (index.js)
   and the HTTP one (http.js), so both transports answer with exactly the same tools. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOLS } from './tools.js'

export function buildServer() {
  const server = new McpServer({ name: 'opengym', version: '0.2.0' })
  for (const t of TOOLS) {
    server.tool(t.name, t.description, t.schema, async (params) => {
      try {
        const result = t.handler(params || {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `${err.code || 'ERROR'}: ${err.message}` }] }
      }
    })
  }
  return server
}
