import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createTestRuntime } from './test-runtime.mjs';

export async function startTestServer(port = 0, options = {}) {
  // Isolated browser fixture: never read .dev.vars or forward real credentials.
  const { runtime, ownerToken } = await createTestRuntime(options);

  const publicRoot = resolve('dist/client');
  const types = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      const file = resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
      if (file !== publicRoot && !file.startsWith(`${publicRoot}${sep}`)) {
        response.writeHead(400).end();
        return;
      }
      const extension = file.slice(file.lastIndexOf('.'));
      if (types[extension]) {
        try {
          const bytes = await readFile(file);
          response
            .writeHead(200, { 'Content-Type': types[extension] })
            .end(bytes);
          return;
        } catch {
          /* Dynamic routes still pass through the authenticated Worker. */
        }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set('Cf-Access-Jwt-Assertion', ownerToken);
      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : Readable.toWeb(request);
      const result = await runtime.dispatchFetch(url, {
        method: request.method,
        headers,
        ...(body ? { body, duplex: 'half' } : {}),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body).pipe(response);
      else response.end();
    } catch {
      response.writeHead(500).end('Browser fixture request failed');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await runtime.dispose();
  }
  return { url, close, runtime, ownerToken };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const fixture = await startTestServer(
    Number(process.env.MONI_TEST_PORT || 3001)
  );
  console.log(`Moni isolated browser fixture: ${fixture.url}`);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
