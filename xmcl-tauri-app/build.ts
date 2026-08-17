import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { build } from 'esbuild'
import { chmod, copyFile, cp, readdir, rm, stat, symlink } from 'fs/promises'
import { delimiter, join, resolve } from 'path'
import { preloadConfig, sidecarConfig } from './esbuild.config'

const dist = resolve(__dirname, 'dist')

/**
 * Stage what the installers ship next to the sidecar bundle: the renderer the
 * sidecar serves over loopback, and the Node runtime the shell spawns.
 *
 * `xmcl-keystone-ui` is built by the workspace (`pnpm build:renderer`), the
 * same bundle the Electron target packs into its asar.
 */
async function stageRenderer() {
  const source = resolve(__dirname, '../xmcl-keystone-ui/dist')
  if (!(await stat(resolve(source, 'index.html')).catch(() => undefined))) {
    throw new Error(
      `The renderer bundle is missing at ${source}. Run \`pnpm build:renderer\` first.`,
    )
  }
  await cp(source, resolve(dist, 'renderer'), { recursive: true })
}

/**
 * Development counterpart of `stageRenderer`.
 *
 * `dist/renderer` is a declared bundle resource, so `cargo build` and
 * `cargo run` refuse to start without it, and `dist/` is wiped on every build.
 * A link keeps the compile step cheap and picks up renderer rebuilds; it is
 * skipped silently when the renderer has never been built, since the shell then
 * runs against the `dev:renderer` server instead.
 */
async function linkRenderer() {
  const source = resolve(__dirname, '../xmcl-keystone-ui/dist')
  if (!existsSync(source)) return
  await symlink(source, resolve(dist, 'renderer'), 'dir').catch(() => undefined)
}

/**
 * The installers cannot rely on a Node runtime being present on the user's
 * machine, so one is packed as a resource — the counterpart of the Electron
 * binary the Electron target ships.
 *
 * The copied runtime is the one running this build, so installers have to be
 * produced on (or for) the target platform, exactly as `electron-builder`
 * requires today. `XMCL_NODE_BINARY` overrides it for cross-building.
 */
async function stageNode() {
  const source = process.env.XMCL_NODE_BINARY || process.execPath
  const target = resolve(dist, process.platform === 'win32' ? 'node.exe' : 'node')
  await copyFile(source, target)
  if (process.platform !== 'win32') await chmod(target, 0o755)
  stripNode(target)
}

/**
 * The Node builds published by nodejs.org keep their symbol table, which is 17
 * MB of an installer that ships nothing to read it with. The bundlers do not
 * strip resources — and on Linux the AppImage bundler is told not to strip at
 * all, since the `strip` linuxdeploy carries is too old for the sections a
 * current toolchain emits.
 *
 * Skipped on macOS, where stripping a signed binary invalidates its signature.
 */
function stripNode(target: string) {
  if (process.platform !== 'linux' || !onPath('strip')) return
  const result = spawnSync('strip', [target], { stdio: 'inherit' })
  if (result.status !== 0) console.warn(`Could not strip ${target}; shipping it as is.`)
}

/**
 * The agent documents the runtime reads at startup. Electron packs them as
 * `extraResources` and resolves them from `process.resourcesPath`; here they sit
 * next to the sidecar, which is the directory the shell exports as
 * `XMCL_RESOURCES_PATH`.
 */
async function stageAgentDocuments() {
  await cp(
    resolve(__dirname, '../xmcl-electron-app/main/agent-documents'),
    resolve(dist, 'agent-documents'),
    { recursive: true },
  )
}

/** Source maps are build artifacts; the Electron installers exclude them too. */
async function dropSourceMaps(directory = dist) {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return dropSourceMaps(path)
      return entry.name.endsWith('.map') ? rm(path, { force: true }) : undefined
    }),
  )
}

function onPath(command: string) {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((directory) => directory && existsSync(join(directory, command)))
}

/**
 * `linuxdeploy` and its AppImage plugin shell out to tools the bundler does not
 * ship, and report a missing one as an opaque `failed to run linuxdeploy` after
 * the whole release build. Checking upfront turns that into an actionable error.
 */
function checkAppImageTools() {
  // `file` is used by appimagetool, `pkg-config` and `find` by linuxdeploy's GTK
  // plugin, which aborts without them. linuxdeploy bundles its own `patchelf`
  // and `strip` and prefers them over the ones on PATH, so those are not
  // requirements. The alternatives are the packages shipping each tool, since
  // none of them are named after it everywhere.
  const tools = {
    file: { debian: 'file', arch: 'file', fedora: 'file' },
    find: { debian: 'findutils', arch: 'findutils', fedora: 'findutils' },
    'pkg-config': { debian: 'pkg-config', arch: 'pkgconf', fedora: 'pkgconf' },
  }
  const missing = Object.keys(tools).filter(
    (tool) => !onPath(tool) && !(tool === 'pkg-config' && onPath('pkgconf')),
  ) as (keyof typeof tools)[]
  if (missing.length === 0) return
  const packages = (distribution: 'debian' | 'arch' | 'fedora') =>
    [...new Set(missing.map((tool) => tools[tool][distribution]))].join(' ')
  throw new Error(
    `The AppImage bundler needs ${missing.join(', ')} on PATH. Install them ` +
      `(Debian/Ubuntu: \`apt install ${packages('debian')}\`, Arch: \`pacman -S ` +
      `${packages('arch')}\`, Fedora: \`dnf install ${packages('fedora')}\`), or ` +
      'drop `appimage` from BUNDLE_TARGETS.',
  )
}

function bundle(args: string[]) {
  return spawnSync('pnpm', args, {
    stdio: 'inherit',
    cwd: __dirname,
    env: {
      // linuxdeploy strips every deployed library with the binutils 2.35 it
      // bundles, which does not know the `.relr.dyn` section that binutils 2.38
      // and glibc 2.36 emit, so on a current distribution every `strip` call
      // fails and it aborts. The libraries come stripped from the distribution
      // and `[profile.release]` already strips ours, so skipping it costs
      // nothing. Overridable, since the variable is only read when set.
      NO_STRIP: '1',
      ...process.env,
    },
  })
}

/**
 * Build the JavaScript half of the Tauri target: the sidecar hosting the
 * runtime and the renderer bridge the shell injects into every window.
 *
 * `BUILD_TARGET=shell` also compiles the Rust shell, and `BUILD_TARGET=bundle`
 * produces the installers through `tauri build`, which needs the renderer and
 * the Node runtime staged in `dist/` first because both are bundle resources.
 */
async function main() {
  const target = process.env.BUILD_TARGET
  await rm(dist, { recursive: true, force: true })

  const started = Date.now()
  await Promise.all([build(sidecarConfig), build(preloadConfig)])
  console.log(`Built sidecar and renderer bridge in ${((Date.now() - started) / 1000).toFixed(2)}s`)

  // Both are declared bundle resources, so `cargo build`/`cargo run` fail
  // without them, and `dist/` is wiped above. The sidecar also reads the agent
  // documents from this directory in development.
  await stageAgentDocuments()
  if (target !== 'bundle') await linkRenderer()

  if (target === 'bundle') {
    await stageRenderer()
    await stageNode()
    await dropSourceMaps()
    console.log('Staged the renderer and the Node runtime in dist/')
    const args = ['exec', 'tauri', 'build']
    // The bundle targets default to the ones declared in `tauri.conf.json`.
    const targets = process.env.BUNDLE_TARGETS
    if (targets) args.push('--bundles', targets)
    // Anything the caller passes after `--` reaches the bundler, e.g.
    // `--verbose`; the separator itself must not, since `tauri build --` hands
    // the rest to `cargo` instead.
    args.push(...process.argv.slice(2).filter((arg) => arg !== '--'))
    if (process.platform === 'linux' && (targets ?? 'appimage').includes('appimage')) {
      checkAppImageTools()
      // The AppImage carries GStreamer so WebKit can play media on a host that
      // does not ship the plugins, which costs around 70 MB. Building without
      // them is a supported trade-off for a distribution-specific package.
      if (process.env.BUNDLE_MEDIA_FRAMEWORK === '0') {
        const override = { bundle: { linux: { appimage: { bundleMediaFramework: false } } } }
        args.push('--config', JSON.stringify(override))
      }
    }
    const result = bundle(args)
    if (result.status === 0) return
    // The bundler pipes linuxdeploy's output into its debug log and reports the
    // failure as a bare `failed to run linuxdeploy`, so the reason is only
    // printed with `--verbose`. Retrying costs seconds — the compilation is
    // already cached — and saves the user a second full build to learn why.
    // Only an actual non-zero exit qualifies: Ctrl-C reaches the bundler as a
    // signal, and retrying it would start the build the user just aborted.
    const retriable = typeof result.status === 'number' && !result.error
    if (retriable && !args.some((arg) => arg === '--verbose' || /^-v+$/.test(arg))) {
      console.error('\nThe bundler failed. Retrying with --verbose to show why.\n')
      bundle([...args, '--verbose'])
    }
    if (result.error) throw result.error
    process.exit(result.status ?? 1)
  }

  if (target === 'shell') {
    const args = ['build', '--manifest-path', resolve(__dirname, 'src-tauri/Cargo.toml')]
    if (process.env.NODE_ENV === 'production') args.push('--release')
    const result = spawnSync('cargo', args, { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
