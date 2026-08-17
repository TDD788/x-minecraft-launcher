/**
 * Shared contract of the network route of the bridge server.
 *
 * Electron gave the launcher a session-level hook: `ElectronSession` claimed
 * `http` and `https` for every webview session and pushed each request through
 * `app.protocol.handle`, which is where the runtime injects the CurseForge
 * `x-api-key`, the Modrinth authorization and the XMCL DPoP proof, and where
 * the virtual `http://launcher` host is answered from local files.
 *
 * WebKitGTK exposes no equivalent hook to a Node process, so the sidecar
 * publishes that same pipeline as one loopback route and the renderer bridge
 * rewrites the requests that need it. Everything else keeps going straight to
 * the network, as it did under Electron.
 */

/** Route of the network proxy on the bridge server. */
export const NETWORK_PATH = '/net'

/** Query parameter carrying the absolute URL to proxy. */
export const NETWORK_URL_PARAM = 'url'

/** Query parameter carrying the per-launch bridge token. */
export const TOKEN_PARAM = 'token'

/**
 * Header carrying the per-launch bridge token. Equivalent to
 * {@link TOKEN_PARAM}, for callers that can set headers; element loads
 * (`<img>`, `<script>`) cannot, hence the parameter.
 */
export const TOKEN_HEADER = 'x-xmcl-bridge-token'

/**
 * Virtual host of the launcher's own resources (`/image`, `/media`, `/icons`,
 * `/theme-media`, `/block-texture`, `/flights`, ...). It is not a real name:
 * only the runtime protocol handlers answer it.
 */
export const LAUNCHER_ORIGIN = 'http://launcher'

/** Build the base of the network route, ending with the URL parameter. */
export function networkEndpoint(port: number, token: string) {
  return `http://127.0.0.1:${port}${NETWORK_PATH}?${TOKEN_PARAM}=${encodeURIComponent(token)}&${NETWORK_URL_PARAM}=`
}

export interface ProxyContext {
  /** Origin of the page issuing the request. */
  origin: string
  /** Result of {@link networkEndpoint}. */
  endpoint: string
  /**
   * Only rewrite the launcher's own virtual host. Used for URLs consumed by
   * elements (`<img>`, `<script>`): a real remote asset loads natively, and
   * sending it through Node would only add a copy.
   */
  internalOnly?: boolean
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * Rewrite a URL onto the network route, or return `undefined` to leave it
 * alone.
 *
 * Left alone: non-HTTP schemes (`data:`, `blob:`, `xmcl:`), the page's own
 * origin and any other loopback address — the bridge, the renderer server and
 * the dev server all live there, and proxying them would loop.
 */
export function resolveProxyUrl(raw: string, ctx: ProxyContext): string | undefined {
  let url: URL
  try {
    url = new URL(raw, ctx.origin)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const internal = url.origin === LAUNCHER_ORIGIN
  if (!internal) {
    if (ctx.internalOnly) return undefined
    if (url.origin === ctx.origin) return undefined
    if (LOOPBACK.has(url.hostname)) return undefined
  }
  return ctx.endpoint + encodeURIComponent(url.toString())
}

/**
 * Hop-by-hop headers, plus the ones that describe a body this process already
 * decoded. Forwarding `content-encoding: gzip` next to an inflated body makes
 * the webview fail the response, and forwarding the client's `content-length`
 * makes it hang.
 */
export const DROPPED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
])
