// Runs the built app. Unpackaged Electron on Linux has no setuid sandbox helper (and Ubuntu 24.04+
// blocks the user-namespace sandbox), so it needs --no-sandbox to start there.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = [root, ...(process.platform === 'linux' ? ['--no-sandbox'] : []), ...process.argv.slice(2)];
const child = spawn(require('electron'), args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
