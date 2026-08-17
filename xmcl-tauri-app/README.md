# xmcl-tauri-app

The Tauri shell of the launcher. It replaces `xmcl-electron-app` only: the
launcher logic stays in `xmcl-runtime`, which runs in a Node sidecar
(`dist/sidecar.js`) supervised by the Rust shell, and the UI stays
`xmcl-keystone-ui`, served by the sidecar over loopback.

```
Rust shell (src-tauri)        windows, tray, deep links, single instance,
                             updater, sidecar supervision
        ▲ shell channel (stdout marker / stdin events)
        ▼
Node sidecar (sidecar/)      xmcl-runtime, sqlite, workers, native modules
        ▲ authenticated loopback bridge (WebSocket /bridge + HTTP)
        ▼
Webview (preload/)           xmcl-keystone-ui + the preload globals
```

## Develop

```bash
pnpm build:renderer                      # or run the renderer dev server
pnpm --filter xmcl-tauri-app run dev
```

`dev.ts` watches the sidecar and preload bundles and points the shell at them
through `XMCL_SIDECAR_DIST`; `XMCL_RENDERER_DIST` points at the renderer bundle.

## Check

```bash
pnpm --filter xmcl-tauri-app run check   # tsc for the sidecar and the preloads
pnpm --filter xmcl-tauri-app run lint
cargo build --manifest-path xmcl-tauri-app/src-tauri/Cargo.toml
```

## Bundle

```bash
pnpm build:renderer
pnpm --filter xmcl-tauri-app run bundle          # every target of tauri.conf.json
BUNDLE_TARGETS=deb pnpm --filter xmcl-tauri-app run bundle
```

The bundle packs the renderer, the sidecar, the preloads, the workers, the
native modules, the agent documents and a Node runtime, so the target machine
needs no Node installed. The staged runtime is the one running the build, so
installers are produced per platform (as `electron-builder` does today);
`XMCL_NODE_BINARY` overrides it for cross-building.

## Provider APIs and the network route

Electron injected the provider credentials by intercepting the webview's traffic
in `ElectronSession`: every `http`/`https` request went through
`app.protocol.handle`, where `pluginApiFallback` adds the CurseForge `x-api-key`,
the Modrinth token and the XMCL DPoP proof. WebKitGTK exposes no such hook to
Node, so the same pipeline is reached over the bridge instead:

```
fetch/XHR in the webview
  → preload/shim/network.ts rewrites the URL to  http://127.0.0.1:<bridge>/net?token=…&url=<original>
  → sidecar/app/NetworkProxy.ts (token-checked, loopback-only)
  → LauncherProtocolHandler with the original absolute URL
  → pluginApiFallback adds the credentials → pluginCommonProtocol fetches upstream
```

Consequences worth knowing:

- The API keys never leave the sidecar. The renderer keeps building its clients
  with an empty key (`clientCurseforgeV1`), exactly as under Electron.
- The proxy answers the CORS preflight itself. CurseForge answers `OPTIONS` with
  404, and Electron never saw a preflight because it intercepted below CORS.
- The bridge token authenticates the hop but is stripped (with `host`, `origin`
  and `referer`) before the upstream request, so it cannot leak to a provider.
- `http://launcher/...` (media, icons, block textures) goes through the same
  route; the HTML the sidecar serves is rewritten because the parser fetches
  `<script src="http://launcher/flights">` before any script can patch it.

`CURSEFORGE_API_KEY` is baked into the sidecar bundle at build time by
`buildEnv.ts`, from `xmcl-tauri-app/.env`, `xmcl-electron-app/.env` or the build
environment — the same value the Electron main bundle uses. Without it the
runtime sends an empty key, CurseForge answers 403 and the marketplace shows no
results; the sidecar logs a warning at startup in that case.

## Updater

`TauriUpdater` keeps the release check against `https://api.xmcl.app/latest`,
because the UI renders its notes and asset list, and delegates applying the
update to the shell, which runs `tauri-plugin-updater`.

In-place updates therefore need two things in `src-tauri/tauri.conf.json`:

1. `plugins.updater.endpoints`, pointing at the `latest.json` manifest of the
   release (the default entry expects it as a release asset).
2. `plugins.updater.pubkey`, the public half of the key the bundles are signed
   with. Generate the pair with `pnpm exec tauri signer generate`, commit the
   public key here and keep the private key and its password in the release
   secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

`pubkey` is empty until the maintainers publish that key, so the shell reports
no signed update, and the runtime falls back to the manual operation — the
release is announced and the user is sent to the download page, which is what
Electron already does for a portable install. Nothing pretends to self-update
while the key is missing.
