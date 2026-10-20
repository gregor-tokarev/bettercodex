// Builds the host daemon, the Electron main/preload scripts and the renderer into dist/.
import { build, context } from 'esbuild';
import { build as viteBuild } from 'vite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const dist = path.join(root, 'dist');

/** Hash of everything that ends up in the host bundle; part of the host version string. */
function buildId() {
  const hash = crypto.createHash('sha256');
  const files = [path.join(root, 'src/shared/types.ts'), path.join(root, 'package-lock.json')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(root, 'src/host'));
  for (const file of files) if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
  return hash.digest('hex').slice(0, 10);
}
const define = { __BUILD_ID__: JSON.stringify(buildId()) };

// playwright-core ships next to host.mjs (not in node_modules, which packagers like to strip).
const vendorPlaywright = {
  name: 'vendor-playwright',
  setup(b) {
    b.onResolve({ filter: /^playwright-core$/ }, () => ({ path: './vendor/playwright-core/index.mjs', external: true }));
  },
};

const hostOptions = {
  entryPoints: [path.join(root, 'src/host/main.ts')],
  outfile: path.join(dist, 'host/host.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'linked',
  define,
  plugins: [vendorPlaywright],
  external: ['bufferutil', 'utf-8-validate'],
  // Bundled CommonJS dependencies (ws) still call require() for Node built-ins.
  banner: { js: "import { createRequire as __bcCreateRequire } from 'node:module'; const require = __bcCreateRequire(import.meta.url);" },
  logLevel: 'info',
};

const electronOptions = {
  entryPoints: { main: path.join(root, 'src/electron/main.ts'), preload: path.join(root, 'src/electron/preload.ts') },
  outdir: path.join(dist, 'electron'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'linked',
  define,
  external: ['electron'],
  logLevel: 'info',
};

/** The host folder is self-contained so it can be copied to remote machines as is. */
function packageHost() {
  const hostDir = path.join(dist, 'host');
  fs.mkdirSync(hostDir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(hostDir, 'package.json'),
    JSON.stringify({ name: 'bettercodex-host', version: pkg.version, type: 'module', private: true }, null, 2),
  );
  const src = path.join(root, 'node_modules/playwright-core');
  const dest = path.join(hostDir, 'vendor/playwright-core');
  fs.rmSync(path.join(hostDir, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

async function main() {
  if (!only || only === 'host') {
    packageHost();
    if (watch) await (await context(hostOptions)).watch();
    else await build(hostOptions);
  }
  if (!only || only === 'electron') {
    if (watch) await (await context(electronOptions)).watch();
    else await build(electronOptions);
  }
  if (!only || only === 'renderer') {
    await viteBuild({ configFile: path.join(root, 'vite.config.ts'), mode: watch ? 'development' : 'production', build: { watch: watch ? {} : null } });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
