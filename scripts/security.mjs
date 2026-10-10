import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'coverage'].includes(item.name)) continue;
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) await walk(filename);
    else if (item.isFile() && /\.(?:mjs|md|json|yml|toml)$/u.test(item.name)) files.push(filename);
  }
}
await walk(root);
const findings = [];
const secretPatterns = [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[a-zA-Z0-9]{30,}\b/u, /\bAKIA[0-9A-Z]{16}\b/u, /\bsk-(?:proj-)?[a-zA-Z0-9_-]{32,}\b/u];
for (const file of files) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const source = await readFile(file, 'utf8');
  if (secretPatterns.some(pattern => pattern.test(source))) findings.push(`${relative}: possible committed credential`);
  if (relative.startsWith('src/')) {
    if (/shell\s*:\s*true/u.test(source)) findings.push(`${relative}: shell execution is forbidden`);
    if (relative !== 'src/process.mjs' && /from\s+['"](?:node:)?child_process['"]/u.test(source)) findings.push(`${relative}: subprocesses must use process.mjs`);
    if (/from\s+['"](?:node:)?(?:https?|http2|dgram|dns)['"]/u.test(source)) findings.push(`${relative}: external network API is forbidden`);
    if (relative !== 'src/ports.mjs' && /from\s+['"](?:node:)?net['"]/u.test(source)) findings.push(`${relative}: only explicit loopback probes may use sockets`);
  }
  if (relative.startsWith('.github/workflows/')) {
    if (/pull_request_target|secrets:\s*inherit|permissions:\s*write-all/u.test(source)) findings.push(`${relative}: unsafe workflow privilege`);
    for (const match of source.matchAll(/uses:\s*([^\s#]+)/gu)) {
      if (!/@[a-f0-9]{40}$/u.test(match[1])) findings.push(`${relative}: action must be pinned to a full commit`);
    }
    if (!/persist-credentials:\s*false/u.test(source)) findings.push(`${relative}: checkout must not persist credentials`);
    if (!/contents:\s*read/u.test(source)) findings.push(`${relative}: workflow must have read-only repository access`);
  }
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) findings.push('package.json: dependency-free contract changed');
for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) if (pkg.scripts?.[name]) findings.push(`package.json: ${name} lifecycle script forbidden`);
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else console.log(`PASS: ${files.length} files checked for targeted secret, execution, dependency, and workflow policy violations. This is a focused policy scan, not a complete security audit.`);
