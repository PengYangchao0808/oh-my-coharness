import assert from 'node:assert/strict'
import test from 'node:test'

import { ADAPTER_TRANSPORTS, adapterFor, createCliAdapter } from '../../src/adapters.js'
import { harnessDef } from '../../src/harnesses.js'

test('every harness resolves to the CLI adapter by default', () => {
  for (const id of ['codex', 'claude', 'kimi', 'opencode']) {
    const adapter = adapterFor(harnessDef(id), {})
    assert.equal(adapter.supported, true, id)
    assert.equal(adapter.transport, 'cli', id)
    assert.equal(adapter.id, id)
  }
  assert.deepEqual([...ADAPTER_TRANSPORTS], ['cli', 'mcp', 'app-server'])
})

test('the CLI adapter exposes one lifecycle and one parser', async () => {
  const adapter = createCliAdapter(harnessDef('codex'))
  assert.equal(typeof adapter.start, 'function')
  assert.equal(typeof adapter.resume, 'function')
  assert.equal(typeof adapter.status, 'function')
  assert.equal(typeof adapter.collect, 'function')
  assert.equal(typeof adapter.cancel, 'function')
  assert.equal(adapter.capabilities().resume, true)
  assert.equal(adapter.session.confidence, 'verified')

  const parsed = adapter.parse([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-adapter' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'adapter answer' } }),
  ].join('\n'))
  assert.equal(parsed.text, 'adapter answer')
  assert.equal(parsed.sessionId, 'thread-adapter')
})

test('an unimplemented transport is refused, not silently treated as CLI', () => {
  const def = harnessDef('codex')
  const mcp = adapterFor(def, { harnesses: { codex: { adapter: 'mcp' } } })
  assert.equal(mcp.supported, false)
  assert.equal(mcp.transport, 'mcp')
  assert.throws(() => mcp.start({}, {}), (error) => error.code === 'OMC/ADAPTER-UNSUPPORTED')

  const app = adapterFor(def, { harnesses: { codex: { adapter: 'app-server' } } })
  assert.equal(app.supported, false)
  assert.equal(app.transport, 'app-server')
})
