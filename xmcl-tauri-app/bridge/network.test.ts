import { describe, expect, it } from 'vitest'
import { NETWORK_PATH, networkEndpoint, resolveProxyUrl } from './network'

const endpoint = networkEndpoint(4321, 'tok en')
const ctx = { origin: 'http://127.0.0.1:9000', endpoint }

const target = (proxied: string | undefined) =>
  proxied && new URL(proxied).searchParams.get('url')

describe('networkEndpoint', () => {
  it('binds the route to loopback and escapes the token', () => {
    const url = new URL(endpoint + encodeURIComponent('https://api.curseforge.com/v1/mods'))
    expect(url.host).toBe('127.0.0.1:4321')
    expect(url.pathname).toBe(NETWORK_PATH)
    expect(url.searchParams.get('token')).toBe('tok en')
    expect(url.searchParams.get('url')).toBe('https://api.curseforge.com/v1/mods')
  })
})

describe('resolveProxyUrl', () => {
  it('proxies the API hosts whose requests the runtime has to authenticate', () => {
    for (const url of [
      'https://api.curseforge.com/v1/mods/search?gameId=432',
      'https://api.modrinth.com/v2/search',
      'https://api.xmcl.app/v1/multiplayer/room',
    ]) {
      expect(target(resolveProxyUrl(url, ctx))).toBe(url)
    }
  })

  it('proxies the launcher virtual host, absolute or relative to it', () => {
    expect(target(resolveProxyUrl('http://launcher/image/abc', ctx)))
      .toBe('http://launcher/image/abc')
    expect(target(resolveProxyUrl('http://launcher/media?path=/tmp/a.png', ctx)))
      .toBe('http://launcher/media?path=/tmp/a.png')
  })

  it('keeps the query string of the proxied URL intact', () => {
    const url = 'https://api.curseforge.com/v1/mods/search?gameId=432&searchFilter=a+b&index=0'
    expect(target(resolveProxyUrl(url, ctx))).toBe(url)
  })

  it('leaves the page origin, other loopback ports and non-HTTP schemes alone', () => {
    for (const url of [
      '/assets/index.js',
      'http://127.0.0.1:9000/index.html',
      'http://127.0.0.1:4321/net',
      'http://localhost:3000/@vite/client',
      'data:image/png;base64,AAA',
      'blob:http://127.0.0.1:9000/1234',
      'xmcl://launcher/auth',
      'not a url',
    ]) {
      expect(resolveProxyUrl(url, ctx)).toBeUndefined()
    }
  })

  it('only rewrites the launcher host for element URLs', () => {
    const internal = { ...ctx, internalOnly: true }
    expect(target(resolveProxyUrl('http://launcher/icons/logoDark', internal)))
      .toBe('http://launcher/icons/logoDark')
    // A remote image loads natively; sending it through Node would only add a copy.
    expect(resolveProxyUrl('https://media.forgecdn.net/a.png', internal)).toBeUndefined()
  })
})
