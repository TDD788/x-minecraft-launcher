import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Build-time secrets of the sidecar bundle.
 *
 * The Electron target bakes them in with `dotenv/config` plus an esbuild
 * `define` (`xmcl-electron-app/esbuild.config.ts`), reading
 * `xmcl-electron-app/.env`, which `postinstall.ts` creates and `.gitignore`
 * excludes. The sidecar hosts the very same runtime, so it needs the same
 * values: without `CURSEFORGE_API_KEY` the runtime sends an empty `x-api-key`
 * and every CurseForge call fails with 403.
 *
 * `xmcl-tauri-app/.env` wins, then the Electron target's file, so a checkout
 * that already builds Electron needs no second copy of the key. The value is
 * only ever read here and in `process.env`; it is never handed to the webview.
 */
const FILES = [
  resolve(__dirname, '.env'),
  resolve(__dirname, '../xmcl-electron-app/.env'),
]

/** Minimal `KEY=VALUE` reader — enough for the files above, and no dependency. */
function parse(content: string) {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const raw = trimmed.slice(separator + 1).trim()
    values[key] = raw.replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

/** Load the files into `process.env` without overriding the real environment. */
export function loadBuildEnv() {
  for (const file of FILES) {
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const [key, value] of Object.entries(parse(content))) {
      if (value && !process.env[key]) process.env[key] = value
    }
  }
}

/**
 * esbuild `define` entries for the values the runtime reads off `process.env`.
 *
 * A variable that is unset — or set to an empty value, which is how
 * `postinstall.ts` leaves the Electron file in a fresh checkout — is left out on
 * purpose rather than defined as `""`: the packaged sidecar then still picks it
 * up from the real environment, which is how a build machine or a developer can
 * inject the key without a `.env` file.
 */
export function buildEnvDefine(keys = ['CURSEFORGE_API_KEY', 'BUILD_NUMBER']) {
  loadBuildEnv()
  const define: Record<string, string> = {}
  for (const key of keys) {
    const value = process.env[key]
    if (!value) continue
    define[`process.env.${key}`] = JSON.stringify(value)
  }
  return define
}
