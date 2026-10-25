#!/usr/bin/env node
/* openGym MCP server — Streamable HTTP transport, for clients that cannot spawn a local
   process: a custom connector in claude.ai (web, desktop and the mobile apps), or any remote
   MCP client. Same read-only tools as the stdio server, same ./data, one profile.

   Auth is a long random token, because a claude.ai custom connector can be either OAuth or
   nothing, and a single-person instance has no business running an OAuth server. The token
   goes in the URL path (https://gym.example.com/mcp/<token>) — the form claude.ai can hold —
   or, for clients that can send headers, as "Authorization: Bearer <token>" on /mcp.
   Without OPENGYM_MCP_TOKEN set the server refuses to start: an open endpoint would hand
   anyone who finds the hostname a person's whole training and body-weight history.

     OPENGYM_DATA=./data OPENGYM_MCP_TOKEN=$(openssl rand -hex 32) node src/http.js

   Stateless: every POST is answered on its own and nothing is kept between requests, so the
   process can restart, or sit behind a tunnel that drops connections, without breaking a chat. */
import http from 'node:http'
import crypto from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer } from './server.js'
import { init, getUser } from './state.js'

export const MIN_TOKEN_LENGTH = 32
const MAX_BODY = 1024 * 1024

const sha = s => crypto.createHash('sha256').update(String(s)).digest()
// Hash both sides first so the comparison takes the same time whatever the length, then compare
// in constant time: the token is the only thing between the internet and the data.
export const tokenMatches = (given, token) => !!given && crypto.timingSafeEqual(sha(given), sha(token))

/** The token a request carries: the last segment of /mcp/<token>, else a Bearer header. */
export function tokenOf(req, pathname) {
  const m = /^\/mcp\/([^/]+)\/?$/.exec(pathname)
  if (m) { try { return decodeURIComponent(m[1]) } catch { return null } }
  if (/^\/mcp\/?$/.test(pathname)) {
    const h = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    return h ? h[1].trim() : null
  }
  return undefined   // not an MCP path at all
}

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const rpcError = (res, code, message, rpc = -32000) => send(res, code, { jsonrpc: '2.0', error: { code: rpc, message }, id: null })

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try { resolve(JSON.parse(raw)) } catch { reject(Object.assign(new Error('body is not JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

export function createHandler({ token, log = () => {} }) {
  if (!token || String(token).length < MIN_TOKEN_LENGTH) {
    throw new Error(`OPENGYM_MCP_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters (try: openssl rand -hex 32)`)
  }
  return async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname === '/healthz') return send(res, 200, { ok: true })

    const given = tokenOf(req, pathname)
    if (given === undefined) return send(res, 404, { error: 'not found' })
    if (!tokenMatches(given, token)) {
      log(`401 ${req.method} (bad or missing token)`)
      return rpcError(res, 401, 'unauthorized')
    }
    // Stateless: there is no session to open a stream on or to end.
    if (req.method !== 'POST') return rpcError(res, 405, 'method not allowed', -32000)

    let body
    try { body = await readBody(req) } catch (e) { return rpcError(res, e.status || 400, e.message, -32700) }

    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      log(`500 ${e.message}`)
      if (!res.headersSent) rpcError(res, 500, 'internal error', -32603)
    }
  }
}

// Run directly: `node src/http.js`. Imported (the tests), it only exports.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +(process.env.MCP_PORT || 3001)
  const host = process.env.MCP_HOST || '0.0.0.0'
  const log = m => console.error(`[opengym-mcp/http] ${m}`)
  let handle
  try { handle = createHandler({ token: process.env.OPENGYM_MCP_TOKEN, log }) } catch (e) { log(e.message); process.exit(1) }
  try { init(); const u = getUser(); log(`serving profile ${u.name} (${u.id})`) } catch (e) { log(e.message) }
  http.createServer(handle).listen(port, host, () => log(`listening on http://${host}:${port}/mcp/<token>`))
}
