import type { IncomingMessage, ServerResponse } from 'http'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { LauncherProtocolHandler } from '@xmcl/runtime/app'
import { DROPPED_HEADERS, NETWORK_URL_PARAM } from '../../bridge/network'

/** Methods that never carry a body, so the client stream is not forwarded. */
const BODYLESS = new Set(['GET', 'HEAD'])

export interface NetworkProxyOptions {
  /**
   * Resolved lazily: the route is registered while the runtime is still being
   * constructed, and the protocol handler only accepts requests afterwards.
   */
  protocol(): LauncherProtocolHandler | undefined
  userAgent(): string
  logger?: Pick<Console, 'warn'>
}

/**
 * Node counterpart of `ElectronSession`'s `protocol.handle('http'|'https')`.
 *
 * The webview hands over an absolute URL and this runs it through the launcher
 * protocol pipeline, which is what adds the provider credentials, so no secret
 * ever reaches the renderer: the CurseForge key stays in this process, exactly
 * as it stayed in the Electron main process.
 */
export function createNetworkProxy(options: NetworkProxyOptions) {
  const logger = options.logger ?? console

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const target = url.searchParams.get(NETWORK_URL_PARAM)
    let parsed: URL | undefined
    try {
      parsed = target ? new URL(target) : undefined
    } catch {
      parsed = undefined
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      // Never echo the rejected value: it can carry a query string the user
      // would not expect in a log.
      logger.warn('[net] rejected a request without a valid absolute http(s) target')
      res.writeHead(400).end()
      return
    }

    const method = req.method ?? 'GET'
    // The webview preflights every request carrying a header like `x-api-key`,
    // and this hop is the one that has to answer: forwarding `OPTIONS` upstream
    // makes the provider answer 404/405 and the real request is never sent.
    // Electron never saw a preflight, because its interception happened inside
    // the session, below CORS.
    if (method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        // Echoed rather than `*`, which older WebKit builds reject.
        'access-control-allow-methods': req.headers['access-control-request-method'] as string,
        'access-control-allow-headers':
          (req.headers['access-control-request-headers'] as string | undefined) ?? '*',
        'access-control-max-age': '86400',
      }).end()
      return
    }

    const protocol = options.protocol()
    if (!protocol) {
      res.writeHead(503).end()
      return
    }

    const controller = new AbortController()
    // A webview that navigates away or a cancelled search must not leave the
    // upstream request running: the runtime queues them and the user would pay
    // for it on the next call.
    const abort = () => controller.abort()
    req.on('aborted', abort)
    res.on('close', () => {
      if (!res.writableEnded) abort()
    })

    const response = await protocol.handle({
      method,
      url: parsed,
      headers: forwardedHeaders(req, options.userAgent()),
      body: BODYLESS.has(method) ? undefined : req,
      signal: controller.signal,
    }).catch((e) => {
      // Upstream failures are the runtime's to report; the renderer only needs
      // a status it can branch on, and the message must not carry credentials.
      logger.warn(`[net] ${method} ${parsed.origin}${parsed.pathname} failed: ${describe(e)}`)
      return undefined
    })

    if (!response) {
      if (!res.headersSent) res.writeHead(502).end()
      return
    }

    // A failing provider call is the most common support question of this route
    // (an expired token, a rate limit, a missing API key), and the webview only
    // sees the status. Log the target without its query string, which can carry
    // a token, and never the headers.
    if (response.status >= 400) {
      logger.warn(`[net] ${method} ${parsed.origin}${parsed.pathname} -> ${response.status}`)
    }

    res.statusCode = response.status
    for (const [key, value] of Object.entries(response.headers)) {
      if (DROPPED_HEADERS.has(key.toLowerCase())) continue
      res.setHeader(key, value as string | string[])
    }
    // The page is served from another loopback origin, so the response is
    // cross-origin for the webview. `ElectronSession` did the same.
    res.setHeader('access-control-allow-origin', '*')

    if (response.body instanceof Readable) {
      await pipeline(response.body, res).catch(() => res.destroy())
    } else {
      res.end(response.body)
    }
  }
}

/**
 * Copy the webview's headers, dropping the ones that describe this hop and the
 * ones that would make the upstream request lie about its target.
 */
function forwardedHeaders(req: IncomingMessage, userAgent: string) {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase()
    if (value === undefined) continue
    if (DROPPED_HEADERS.has(name)) continue
    // `host` and `origin` point at the loopback route; `referer` would leak the
    // bridge token to the upstream server, since it is in the proxied URL.
    if (name === 'host' || name === 'origin' || name === 'referer') continue
    headers[key] = value
  }
  headers['user-agent'] = userAgent
  return headers
}

function describe(e: unknown) {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}
