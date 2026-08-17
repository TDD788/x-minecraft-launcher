/**
 * Entry point of the Node sidecar.
 *
 * The Tauri shell spawns this file, hands it a loopback port and a per-launch
 * token through the environment, and waits for the ready marker on stdout. From
 * there this process is what the Electron main process used to be: it hosts
 * `xmcl-runtime` with its services, workers and native modules, answers the
 * webview over the bridge, and drives windows through the shell control channel.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { NETWORK_PATH, networkEndpoint } from '../bridge/network'
import { READY_MARKER } from '../bridge/protocol'
import { createNetworkProxy } from './app/NetworkProxy'
import { TauriLauncherApp } from './app/TauriLauncherApp'
import { createDefaultApp } from './app/defaultApp'
import { RendererServer } from './app/RendererServer'
import { BridgeServer } from './bridge/BridgeServer'
import { ShellClient } from './shell/ShellClient'

const token = process.env.XMCL_BRIDGE_TOKEN
const port = Number(process.env.XMCL_BRIDGE_PORT ?? '0')
const devServer = process.env.XMCL_DEV_SERVER

if (!token) {
  console.error('[sidecar] XMCL_BRIDGE_TOKEN is required; the shell must generate it')
  process.exit(2)
}

// An unhandled rejection anywhere in the runtime must not take the launcher
// down: the shell would restart the sidecar and the user would lose the
// in-flight installs.
process.on('uncaughtException', (e) => console.error('[sidecar] uncaught', e))
process.on('unhandledRejection', (e) => console.error('[sidecar] unhandled rejection', e))

async function getVersion() {
  const pkg = await readFile(join(__dirname, '..', 'package.json'), 'utf-8')
    .catch(() => readFile(join(__dirname, 'package.json'), 'utf-8'))
    .catch(() => '{}')
  return (JSON.parse(pkg).version as string | undefined) ?? '0.0.0'
}

async function main() {
  const bridge = new BridgeServer(token!)
  const shell = new ShellClient()

  bridge.handle('bridge-info', () => ({
    pid: process.pid,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),
  }))

  // The webview's replacement for `ElectronSession`'s request interception: the
  // launcher's virtual `http://launcher` host and the API calls that need the
  // runtime to inject provider credentials come back through this route. It is
  // registered before `listen` and reads the protocol handler lazily, since the
  // runtime is constructed below.
  let launcher: TauriLauncherApp | undefined
  bridge.route(
    NETWORK_PATH,
    createNetworkProxy({
      protocol: () => launcher?.protocol,
      userAgent: () => launcher?.userAgent ?? '',
    }),
  )

  const listening = await bridge.listen(port)

  // The renderer origin has to exist before the manifest is built, because the
  // manifest URL is what the shell loads and what the runtime keys app data on.
  const renderer = new RendererServer(
    process.env.XMCL_RENDERER_DIST ?? join(__dirname, 'renderer'),
    networkEndpoint(listening, token!),
  )
  const url = devServer
    ? `${devServer}/index.html`
    : `http://127.0.0.1:${await renderer.listen()}/index.html`

  const app: TauriLauncherApp = new TauriLauncherApp({
    bridge,
    shell,
    builtinAppManifest: createDefaultApp(url),
    version: await getVersion(),
    env: process.env.APPIMAGE ? 'appimage' : 'raw',
    isDev: process.env.NODE_ENV === 'development',
  })
  launcher = app
  renderer.setProtocol(app.protocol)

  // Ready before `start()`: the shell keeps the splash up until it sees this,
  // and the runtime's own boot can take seconds on a cold profile.
  console.log(`${READY_MARKER}${JSON.stringify({ port: listening, url })}`)
  console.log(`[sidecar] node ${process.versions.node} pid ${process.pid}`)
  if (!process.env.CURSEFORGE_API_KEY) {
    // Only whether it is set — never the value. Without it the runtime sends an
    // empty `x-api-key` and every CurseForge call answers 403, which looks like
    // a network failure in the UI.
    console.warn('[sidecar] CURSEFORGE_API_KEY is not set; CurseForge requests will be rejected')
  }

  const stop = async () => {
    await bridge.close().catch(() => undefined)
    await renderer.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  // The shell owns this process through the stdio pipes. If it dies without
  // terminating the sidecar, the orphan keeps the sqlite lock of the profile and
  // the next launch boots against a locked database.
  process.stdin.on('end', () => void stop())
  process.stdin.on('close', () => void stop())

  await app.start()
}

main().catch((e) => {
  console.error('[sidecar] failed to start', e)
  process.exit(1)
})
