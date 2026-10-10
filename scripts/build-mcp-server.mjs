#!/usr/bin/env node
/**
 * Bundle the DragonFruit MCP server (tools/dragonfruit-mcp/server.mjs) into a
 * single self-contained CommonJS file that ships inside the installer as a
 * Tauri resource (src-tauri/mcp-resources/dragonfruit-mcp.cjs → resource_dir).
 * Users run it with plain `node` — no npm install on their machine.
 *
 * Runs from predev:once and beforeBuildCommand. Installs the tool's own deps
 * the first time, and skips the bundle when it is already up to date
 * (pass --force to rebuild).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolDir = path.join(root, 'tools', 'dragonfruit-mcp');
const entry = path.join(toolDir, 'server.mjs');
const outFile = path.join(root, 'src-tauri', 'mcp-resources', 'dragonfruit-mcp.cjs');
const force = process.argv.includes('--force');

const mtime = (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);

if (!fs.existsSync(path.join(toolDir, 'node_modules'))) {
  console.log('[build-mcp-server] installing tools/dragonfruit-mcp dependencies…');
  const hasLock = fs.existsSync(path.join(toolDir, 'package-lock.json'));
  execSync(`npm ${hasLock ? 'ci' : 'install'} --no-audit --no-fund`, { cwd: toolDir, stdio: 'inherit' });
}

const upToDate = !force
  && mtime(outFile) > 0
  && mtime(outFile) >= mtime(entry)
  && mtime(outFile) >= mtime(path.join(toolDir, 'package-lock.json'));
if (upToDate) {
  console.log('[build-mcp-server] dragonfruit-mcp.cjs is up to date');
  process.exit(0);
}

const esbuild = createRequire(path.join(toolDir, 'package.json'))('esbuild');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
esbuild.buildSync({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // Optional native speed-ups that `ws` probes for with try/require.
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`[build-mcp-server] wrote ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
