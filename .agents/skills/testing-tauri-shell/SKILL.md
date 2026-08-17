---
name: testing-tauri-shell
description: How to build, launch and end-to-end test the xmcl-tauri-app (Rust/Tauri shell + Node sidecar) on a Linux desktop box, including the LANG/DBus requirements, the sidecar /net proxy checks and safe profile handling.
---

# Testing the Tauri shell (`xmcl-tauri-app`)

## Build & launch

```bash
source ~/.nvm/nvm.sh && nvm use 22.16.0
pnpm --filter xmcl-tauri-app run compile      # dist/sidecar.js + dist/preload.js
cd xmcl-tauri-app/src-tauri && cargo build     # debug binary at target/debug/xmcl-tauri-app
pnpm run dev:renderer                          # vite on :3000 — reuse an existing one if running
```

Run with a throwaway profile and remove it afterwards:

```bash
DISPLAY=:0 \
XDG_CONFIG_HOME=/tmp/xmcl-tauri-run \
XMCL_DEV_SERVER=http://localhost:3000 \
XMCL_SIDECAR_DIST=<repo>/xmcl-tauri-app/dist \
./target/debug/xmcl-tauri-app > /tmp/tauri.log 2>&1 &
```

Never point Electron and Tauri at the same profile (SQLite "database is locked").

Always export a real language locale, e.g. `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. Agent
boxes default to `LANG=C.UTF-8`; WebKitGTK then reports `navigator.language` as something
`Intl.DateTimeFormat` rejects, so pages that format dates (the `/store` marketplace via
`util/date.ts` → `useRecentMinecraftItems`) render as a **blank white page**. Chromium/Electron
tolerates this, so it looks like a Tauri-only bug. Suspect the locale first.

Omit `XMCL_DEV_SERVER` to exercise the sidecar's `RendererServer` with the built renderer
(`xmcl-keystone-ui/dist`, symlinked as `dist/renderer` by `compile`). `[Flights] Fetched
flights` in the log proves the parser-time `http://launcher/flights` rewrite worked.

## Debugging renderer JS errors without the inspector

The WebKit inspector can crash the shell, so temporarily append a `<script>` to
`xmcl-keystone-ui/src/index.html` that wraps `console.error` / `window.onerror` and paints
the text into a fixed `<pre>` overlay (visible in screenshots) — the vite dev server picks
it up on reload. Revert the file afterwards (`git status` must be clean).

## Single-instance / deep-link tests need a DBus session bus

`tauri-plugin-single-instance` on Linux uses the DBus **session** bus. Agent shells
usually have no `DBUS_SESSION_BUS_ADDRESS`, so a second launch silently boots a whole
second app (second bridge port + `[ResourceContext] Error: database is locked`) and the
test looks like a product bug. Grab the desktop session's address first:

```bash
for p in $(pgrep -u $(id -u) .); do tr '\0' '\n' < /proc/$p/environ 2>/dev/null \
  | grep -m1 '^DBUS_SESSION_BUS_ADDRESS' && break; done
```

Export the same `DBUS_SESSION_BUS_ADDRESS` for both the first and the second launch.
With it set, the second launch exits 0 and the running window is un-minimized/focused.

Deep links on Linux arrive as a second launch argument:
`./target/debug/xmcl-tauri-app 'xmcl://launcher/app?url=https://example.invalid/x'` —
the sidecar logs `[LauncherAppManager] Boot app from app url ...`, which is convenient
proof of delivery (the fetch failure for an invalid host is expected).

## Killing processes safely

`pkill -f 'target/debug/xmcl-tauri-app'` also matches the `bash -c` wrapper running the
command and kills your own shell. Use `pkill -x xmcl-tauri-app` and
`pkill -f 'sidecar\.js'` instead.

## Gotchas observed

- Opening the WebKit inspector from the webview context menu can abort the shell with
  `[xcb] Unknown sequence number ... Assertion !xcb_xlib_threads_sequence_lost failed`.
  Avoid the inspector; read `/tmp/tauri.log` (it carries `[sidecar:out]`/`[sidecar:err]`)
  instead.
- Window close behavior changed over revisions: it may keep shell+sidecar alive
  (`prevent_exit`, app then unreachable) or log `[Controller] All windows closed.
  parking=false` and quit like Electron. Check `pgrep -x xmcl-tauri-app` and the log before
  calling either one a bug, and always retry a relaunch afterwards.
- A webview reload (F5) once killed the shell silently (no panic, no log line); two later
  reloads were fine. If the app vanishes without log output, suspect a webkit2gtk crash and
  retry rather than assuming a logic bug.
- Provider APIs go through the sidecar proxy route `/net`; only responses >= 400 are logged,
  as `[net] GET <origin><path> -> <status>` (no query, no headers). Useful greps:
  `grep '\[net\]' /tmp/tauri.log`, and `grep -E 'x-api-key|token=|Authorization'` to prove no
  secret leaks. With an empty `CURSEFORGE_API_KEY` the expected result is
  `[net] GET https://api.curseforge.com/v1/mods/search -> 403` and **no** `OPTIONS ... -> 404`
  (preflights are answered locally); Modrinth needs no key and is the reliable smoke test.
- Some upstreams are flaky: `api.xmcl.app/latest` (updater) and `api.xmcl.app/news` returned
  500/404 at times, so the updater's Azure fallback may be unexercised when the primary
  works. Record the endpoint status with `curl` before judging updater behavior.
- Sidecar supervision: `kill -9` the node process; the shell logs
  `[sidecar] exited with -1; restarting (1/5)` and reuses the same bridge port/token, and
  the webview re-attaches without a reload.

## Useful checks

- geometry: `DISPLAY=:0 wmctrl -lG | grep KeyStone` (default 1200x720, min clamp 800x400)
- bridge: `grep -E 'bridge listening|window connected' /tmp/tauri.log`

## Devin Secrets Needed

None.
