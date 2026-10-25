// The Streamable HTTP entry point: token gate, the MCP handshake, and a real tool call over
// the wire against the demo state.
import { describe, beforeAll, afterAll, test, expect, vi } from 'vitest'
import http from 'node:http'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests } from '../src/state.js'
import { createHandler, tokenMatches, tokenOf, MIN_TOKEN_LENGTH } from '../src/http.js'

const TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + '0123456789abcdef'
let srv, base

beforeAll(async () => {
  vi.useFakeTimers({ now: new Date('2026-07-27T10:00:00'), toFake: ['Date'] })
  _seedStateForTests(buildDemoState())
  srv = http.createServer(createHandler({ token: TOKEN }))
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${srv.address().port}`
})
afterAll(async () => { vi.useRealTimers(); await new Promise(r => srv.close(r)) })

const rpc = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
})
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }

describe('token gate', () => {
  test('refuses to start without a long token', () => {
    expect(() => createHandler({ token: '' })).toThrow(/OPENGYM_MCP_TOKEN/)
    expect(() => createHandler({ token: 'x'.repeat(MIN_TOKEN_LENGTH - 1) })).toThrow()
  })
  test('compares tokens exactly', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches(TOKEN + 'x', TOKEN)).toBe(false)
    expect(tokenMatches('', TOKEN)).toBe(false)
    expect(tokenMatches(null, TOKEN)).toBe(false)
  })
  test('reads the token from the path or a Bearer header', () => {
    expect(tokenOf({ headers: {} }, '/mcp/abc')).toBe('abc')
    expect(tokenOf({ headers: { authorization: 'Bearer abc' } }, '/mcp')).toBe('abc')
    expect(tokenOf({ headers: {} }, '/mcp')).toBe(null)
    expect(tokenOf({ headers: {} }, '/elsewhere')).toBe(undefined)
  })
  test('answers 401 to a wrong or missing token and 404 off the MCP path', async () => {
    expect((await rpc('/mcp/wrong', INIT)).status).toBe(401)
    expect((await rpc('/mcp', INIT)).status).toBe(401)
    expect((await rpc('/', INIT)).status).toBe(404)
  })
  test('has an unauthenticated health check that says nothing else', async () => {
    const r = await fetch(base + '/healthz')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })
})

describe('MCP over HTTP', () => {
  test('initialize works with the token in the path', async () => {
    const r = await rpc('/mcp/' + TOKEN, INIT)
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.result.serverInfo.name).toBe('opengym')
  })

  test('lists the same read-only tools as stdio', async () => {
    const j = await (await rpc('/mcp/' + TOKEN, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).json()
    const names = j.result.tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_workouts', 'get_workout', 'estimate_1rm', 'muscle_balance', 'get_bodyweight']))
  })

  test('calls a tool with a Bearer header', async () => {
    const j = await (await rpc('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_workouts', arguments: { limit: 2 } } },
      { authorization: 'Bearer ' + TOKEN })).json()
    const out = JSON.parse(j.result.content[0].text)
    expect(JSON.stringify(out)).toContain('Leg Day')
  })

  test('refuses GET (no sessions to stream) and a body that is not JSON', async () => {
    expect((await fetch(base + '/mcp/' + TOKEN)).status).toBe(405)
    const bad = await fetch(base + '/mcp/' + TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(bad.status).toBe(400)
  })
})
