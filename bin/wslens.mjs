#!/usr/bin/env node
import { main } from '../src/cli.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('WSLens requires Node.js 22 or newer.\n');
  process.exitCode = 2;
} else {
  const deadline = setTimeout(() => {
    process.stderr.write('WSLens: the 20-second command limit was reached. A filesystem or network-mounted PATH entry may be unresponsive.\n', () => process.exit(2));
  }, 20000);
  deadline.unref();
  const pendingStderr = [];
  process.stdout.on('error', error => {
    if (error.code === 'EPIPE') process.exit(0);
    pendingStderr.push(new Promise(resolve => process.stderr.write('WSLens: unable to write output.\n', resolve)));
  });
  const code = await main();
  clearTimeout(deadline);
  // Exit deliberately releases non-cancellable filesystem work; first drain
  // diagnostic writes, including errors emitted by the stdout stream.
  await Promise.all(pendingStderr);
  process.exit(pendingStderr.length ? 2 : code);
}
