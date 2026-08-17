---
name: testing-tauri-shell
description: How to build, launch and end-to-end test the xmcl-tauri-app (Rust/Tauri shell + Node sidecar) on a Linux desktop box, including the DBus requirement for single-instance/deep-link tests and safe profile handling.
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
- Closing the last window keeps the shell + sidecar alive (`prevent_exit`) but nothing
  re-opens a window: a relaunch is swallowed by single-instance and there is no tray, so
  the app becomes unreachable. Verify this before assuming the app "hung".
- CurseForge marketplace calls may fail (`CurseForgeApiError`) independently of the
  bridge; Modrinth search is the reliable bridge smoke test.
- Sidecar supervision: `kill -9` the node process; the shell logs
  `[sidecar] exited with -1; restarting (1/5)` and reuses the same bridge port/token, and
  the webview re-attaches without a reload.

## Useful checks

- geometry: `DISPLAY=:0 wmctrl -lG | grep KeyStone` (default 1200x720, min clamp 800x400)
- bridge: `grep -E 'bridge listening|window connected' /tmp/tauri.log`

## Devin Secrets Needed

None.
