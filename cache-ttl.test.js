import test from 'node:test'
import assert from 'node:assert/strict'
import CacheTtlPlugin from './cache-ttl.js'

test('CacheTtlPlugin', async (t) => {
  const originalFetch = globalThis.fetch

  t.afterEach(() => {
    globalThis.fetch = originalFetch
  })

  await t.test('skips when enabled: false', async () => {
    const plugin = await CacheTtlPlugin({}, { enabled: false })
    assert.deepEqual(plugin, {})
    assert.equal(globalThis.fetch, originalFetch)
  })

  await t.test('skips when invalid ttl provided', async () => {
    const originalConsoleError = console.error
    let errorCalled = false
    console.error = () => { errorCalled = true }
    
    const plugin = await CacheTtlPlugin({}, { ttl: '10m' })
    assert.deepEqual(plugin, {})
    assert.equal(globalThis.fetch, originalFetch)
    assert.equal(errorCalled, true)
    
    console.error = originalConsoleError
  })

  await t.test('stamps ttl on anthropic fetch requests', async () => {
    // mock global fetch
    let fetchCallCount = 0
    let fetchArgs = []
    const mockFetch = async (input, init) => {
      fetchCallCount++
      fetchArgs.push({ input, init })
      return {} // minimal Response stub
    }
    globalThis.fetch = mockFetch

    const originalConsoleError = console.error
    console.error = () => {} // silence init log

    const plugin = await CacheTtlPlugin({}, { ttl: '1h' })
    
    // test fetch
    const body = JSON.stringify({
      model: 'claude-3-opus-20240229',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World', cache_control: { type: 'ephemeral' } }
          ]
        }
      ]
    })
    
    await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body
    })

    assert.equal(fetchCallCount, 1)
    const interceptedInit = fetchArgs[0].init
    const interceptedBody = JSON.parse(interceptedInit.body)
    
    assert.equal(interceptedBody.messages[0].content[1].cache_control.ttl, '1h')
    
    await plugin.dispose()
    assert.equal(globalThis.fetch, mockFetch)
    console.error = originalConsoleError
  })
  
  await t.test('idempotent wrapping', async () => {
    const originalConsoleError = console.error
    console.error = () => {} // silence init log
    
    globalThis.fetch = async () => {}
    
    const plugin1 = await CacheTtlPlugin({}, { ttl: '1h' })
    const fetch1 = globalThis.fetch
    assert.ok(fetch1.__cacheTtlWrapped)
    
    const plugin2 = await CacheTtlPlugin({}, { ttl: '1h' })
    const fetch2 = globalThis.fetch
    assert.equal(fetch1, fetch2) // should not wrap again
    
    await plugin1.dispose()
    if (plugin2.dispose) await plugin2.dispose() // does nothing since it didn't wrap
    console.error = originalConsoleError
  })
  
  await t.test('respects agents filter via argv', async () => {
    const originalArgv = process.argv
    const originalConsoleError = console.error
    console.error = () => {}
    globalThis.fetch = async () => {} // reset mock fetch

    // Not in agents list
    process.argv = ['node', 'opencode', '--agent', 'other-agent']
    const plugin1 = await CacheTtlPlugin({}, { agents: ['expensive-agent'], ttl: '1h' })
    assert.deepEqual(plugin1, {}) // inactive

    // No agent provided in argv (server mode) -> acts like active
    process.argv = ['node', 'opencode']
    const plugin2 = await CacheTtlPlugin({}, { agents: ['expensive-agent'], ttl: '1h' })
    assert.ok(globalThis.fetch.__cacheTtlWrapped)
    if (plugin2.dispose) await plugin2.dispose()

    // Agent in list (using equals sign)
    process.argv = ['node', 'opencode', '--agent=expensive-agent']
    const plugin3 = await CacheTtlPlugin({}, { agents: ['expensive-agent'], ttl: '1h' })
    assert.ok(globalThis.fetch.__cacheTtlWrapped)
    if (plugin3.dispose) await plugin3.dispose()

    process.argv = originalArgv
    console.error = originalConsoleError
  })
  
  await t.test('ignores non-anthropic requests', async () => {
    let fetchCallCount = 0
    let fetchArgs = []
    globalThis.fetch = async (input, init) => {
      fetchCallCount++
      fetchArgs.push({ input, init })
    }

    const originalConsoleError = console.error
    console.error = () => {}

    const plugin = await CacheTtlPlugin({}, { ttl: '1h' })
    
    const body = JSON.stringify({
      messages: [{ content: [{ cache_control: { type: 'ephemeral' } }] }]
    })
    
    await globalThis.fetch('https://api.openai.com/v1/chat/completions', { body })
    
    assert.equal(fetchCallCount, 1)
    const interceptedBody = JSON.parse(fetchArgs[0].init.body)
    // should not have stamped ttl since url is not anthropic
    assert.equal(interceptedBody.messages[0].content[0].cache_control.ttl, undefined)
    
    await plugin.dispose()
    console.error = originalConsoleError
  })
})
