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
  process.stdout.on('error', error => {
    if (error.code === 'EPIPE') process.exit(0);
    process.stderr.write('WSLens: unable to write output.\n');
    process.exitCode = 2;
  });
  const code = await main();
  clearTimeout(deadline);
  // Output has been flushed by main. Exit also releases non-cancellable fs work
  // that a timed-out diagnostic adapter may have left in the libuv thread pool.
  process.exit(code);
}
