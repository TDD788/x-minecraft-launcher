// The module directly, not the package entry: importing `@xmcl/runtime/app`
// pulls the service decorators, which need the runtime's DI setup.
import { LauncherProtocolHandler, type Request } from '~/app/LauncherProtocolHandler'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NETWORK_PATH, networkEndpoint } from '../../bridge/network'
import { BridgeServer } from '../bridge/BridgeServer'
import { createNetworkProxy } from './NetworkProxy'

const TOKEN = 'a-token'

describe('createNetworkProxy', () => {
  let server: BridgeServer
  let endpoint: string
  let seen: Request[]
  let fail: Error | undefined

  beforeEach(async () => {
    seen = []
    fail = undefined
    const protocol = new LauncherProtocolHandler()
    // Stands in for the runtime plugins: they are the ones adding the provider
    // credentials, and what matters here is that they see the original request.
    const record = ({ request, response }: { request: Request; response: any }) => {
      seen.push(request)
      if (fail) throw fail
      response.status = 200
      response.headers = { 'content-type': 'application/json', 'content-encoding': 'gzip' }
      response.body = JSON.stringify({ host: request.url.host, method: request.method })
    }
    protocol.registerHandler('https', record, true)
    protocol.registerHandler('http', record, true)

    server = new BridgeServer(TOKEN, { log() {}, warn() {}, error() {} })
    server.route(NETWORK_PATH, createNetworkProxy({
      protocol: () => protocol,
      userAgent: () => 'xmcl/test',
      logger: { warn() {} },
    }))
    endpoint = networkEndpoint(await server.listen(0), TOKEN)
  })

  afterEach(() => server.close())

  it('runs the request through the protocol pipeline with its original URL', async () => {
    const response = await fetch(endpoint + encodeURIComponent('https://api.curseforge.com/v1/mods/search?gameId=432'), {
      headers: { 'x-api-key': '' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ host: 'api.curseforge.com', method: 'GET' })
    const [request] = seen
    expect(request.url.protocol).toBe('https:')
    expect(request.url.host).toBe('api.curseforge.com')
    expect(request.url.searchParams.get('gameId')).toBe('432')
    // The renderer's empty key is what `CurseforgeV1Client('')` sends; the
    // runtime plugin overwrites it, so it must arrive as a plain header.
    expect(request.headers['x-api-key']).toBe('')
    expect(request.headers['user-agent']).toBe('xmcl/test')
  })

  it('keeps the launcher virtual host on the http protocol', async () => {
    await fetch(endpoint + encodeURIComponent('http://launcher/image/0123'))
    expect(seen[0].url.protocol).toBe('http:')
    expect(seen[0].url.host).toBe('launcher')
    expect(seen[0].url.pathname).toBe('/image/0123')
  })

  it('forwards the method and the body', async () => {
    await fetch(endpoint + encodeURIComponent('https://api.modrinth.com/v2/version_files'), {
      method: 'POST',
      body: JSON.stringify({ hashes: ['a'] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(seen[0].method).toBe('POST')
    expect(seen[0].headers['content-type']).toBe('application/json')
    expect(seen[0].body).toBeDefined()
  })

  it('hides the loopback hop and the token from the upstream request', async () => {
    await fetch(endpoint + encodeURIComponent('https://api.curseforge.com/v1/mods'), {
      headers: { referer: 'http://127.0.0.1:1/net?token=a-token', origin: 'http://127.0.0.1:1' },
    })
    for (const header of ['host', 'origin', 'referer']) {
      expect(seen[0].headers[header]).toBeUndefined()
    }
  })

  it('drops the response headers that describe the decoded body', async () => {
    const response = await fetch(endpoint + encodeURIComponent('https://api.curseforge.com/v1/mods'))
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers the preflight itself instead of forwarding it upstream', async () => {
    const response = await fetch(endpoint + encodeURIComponent('https://api.curseforge.com/v1/mods'), {
      method: 'OPTIONS',
      headers: {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-api-key,content-type',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toBe('POST')
    expect(response.headers.get('access-control-allow-headers')).toBe('x-api-key,content-type')
    // CurseForge answers 404 to `OPTIONS`, which would fail the preflight.
    expect(seen).toHaveLength(0)
  })

  it('answers 502 when the pipeline throws, without leaking the reason', async () => {
    fail = new Error('secret-bearing failure')
    const response = await fetch(endpoint + encodeURIComponent('https://api.curseforge.com/v1/mods'))
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('')
  })

  it('rejects a target that is not an absolute http(s) URL', async () => {
    for (const target of ['', 'file:///etc/passwd', 'xmcl://launcher', '/v1/mods']) {
      const response = await fetch(endpoint + encodeURIComponent(target))
      expect(response.status).toBe(400)
    }
    expect(seen).toHaveLength(0)
  })

  it('requires the per-launch token', async () => {
    const url = new URL(endpoint + encodeURIComponent('https://api.curseforge.com/v1/mods'))
    url.searchParams.set('token', 'wrong')
    expect((await fetch(url)).status).toBe(401)
    url.searchParams.delete('token')
    expect((await fetch(url)).status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  it('serves nothing else', async () => {
    const url = new URL(endpoint)
    url.pathname = '/'
    expect((await fetch(url)).status).toBe(404)
  })
})
