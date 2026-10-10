// Simulate an asynchronous/backpressured stderr destination before loading the CLI.
import { appendFileSync } from 'node:fs';

const destination = process.env.WSLENS_STDERR_CAPTURE;
if (!destination) throw new Error('Test fixture requires a capture destination.');
process.stderr.write = (chunk, encoding, callback) => {
  const complete = typeof encoding === 'function' ? encoding : callback;
  setTimeout(() => {
    appendFileSync(destination, String(chunk));
    complete?.();
  }, 75);
  return false;
};
