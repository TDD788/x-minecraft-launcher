/**
 * Renderer half of the network interception `ElectronSession` used to do.
 *
 * Under Electron every webview request went through `app.protocol.handle`, so
 * the runtime could answer the virtual `http://launcher` host and add the
 * provider credentials (CurseForge `x-api-key`, Modrinth authorization, XMCL
 * DPoP) without the page ever seeing them. WebKitGTK has no such hook, so the
 * requests that need it are rewritten here onto the sidecar's network route.
 *
 * Scope, deliberately narrow:
 * - `fetch` and `XMLHttpRequest`: rewritten for `http://launcher` and for every
 *   cross-origin HTTP(S) request, which is what restores the credential
 *   injection — and, as a side effect, makes the API clients work at all,
 *   since a plain webview request to `api.curseforge.com` is a cross-origin
 *   request the page cannot read.
 * - element URLs (`src` / `href`): rewritten for `http://launcher` only. A
 *   remote image or stylesheet already loads natively and does not need
 *   credentials; routing it through Node would only add a copy.
 */

import { networkEndpoint, resolveProxyUrl } from '../../bridge/network'
import { getBridgeConfig } from '../bridge/client'

const endpoint = networkEndpoint(getBridgeConfig().port, getBridgeConfig().token)

const context = () => ({ origin: location.origin, endpoint })
const rewrite = (raw: string) => resolveProxyUrl(raw, context())
const rewriteInternal = (raw: string) => resolveProxyUrl(raw, { ...context(), internalOnly: true })

/** `fetch` accepts a string, a `URL` or a `Request`; only the last keeps state. */
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

function installFetch() {
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const proxied = rewrite(urlOf(input))
    if (!proxied) return original(input as RequestInfo, init)
    if (typeof input === 'string' || input instanceof URL) {
      return original(proxied, init)
    }
    // A `Request` carries the method, headers and body the caller built, and
    // its URL is read-only: rebuild it on the proxied URL. The body has to be
    // buffered because a `Request` body is a stream and WebKit does not
    // implement request streaming.
    const request = input as Request
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.clone().arrayBuffer()
    return original(
      new Request(proxied, {
        method: request.method,
        headers: request.headers,
        body,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity,
        signal: request.signal,
      }),
      init,
    )
  }
}

function installXhr() {
  const open = XMLHttpRequest.prototype.open
  // The overload with the credentials arguments is the one the DOM defines;
  // callers in the UI only use the first three.
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const raw = typeof url === 'string' ? url : url.href
    return (open as (...args: unknown[]) => void).call(this, method, rewrite(raw) ?? raw, ...rest)
  } as typeof XMLHttpRequest.prototype.open
}

/**
 * Element URLs. Both paths matter: Vue writes `src` through `setAttribute`, and
 * imperative code (`new Image().src = ...`) writes the property.
 */
function installElements() {
  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if ((name === 'src' || name === 'href') && typeof value === 'string') {
      return setAttribute.call(this, name, rewriteInternal(value) ?? value)
    }
    return setAttribute.call(this, name, value)
  }

  const targets: [{ prototype: Element }, string][] = [
    [HTMLImageElement, 'src'],
    [HTMLScriptElement, 'src'],
    [HTMLSourceElement, 'src'],
    [HTMLMediaElement, 'src'],
    [HTMLLinkElement, 'href'],
  ]
  for (const [type, property] of targets) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, property)
    if (!descriptor?.set || !descriptor.get) continue
    Object.defineProperty(type.prototype, property, {
      ...descriptor,
      set(this: Element, value: string) {
        descriptor.set!.call(this, typeof value === 'string' ? rewriteInternal(value) ?? value : value)
      },
    })
  }
}

installFetch()
installXhr()
installElements()
