import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixturePaths = [
  'telegram/tests/telegram-media-downloader.fixture.html',
  'telegram/tests/telegram-web-a-audio-downloader.fixture.html',
  'youtube/tests/youtube-audio-capture.fixture.html',
];
const viewports = [
  { name: 'desktop', width: 1440, height: 1000, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
]);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      resolve(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA &&
      resolve(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known executable.
    }
  }
  throw new Error('Chrome/Chromium was not found. Set CHROME_BIN to its executable path.');
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const filePath = resolve(root, `.${pathname}`);
      if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error('Not a file');
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': mimeTypes.get(extname(filePath)) || 'application/octet-stream',
      });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end('Not found');
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return server;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolveMessage, rejectMessage, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) rejectMessage(new Error(message.error.message));
      else resolveMessage(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', () => rejectOpen(new Error('CDP WebSocket failed.')), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectMessage(new Error(`CDP command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolveMessage, rejectMessage, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function startChrome(executable, profileDirectory) {
  const child = spawn(executable, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-gpu',
    '--no-default-browser-check',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  try {
    const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
      let stderr = '';
      const timer = setTimeout(
        () => rejectEndpoint(new Error(`Chrome did not expose CDP.\n${stderr}`)),
        10000
      );
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (!match) return;
        clearTimeout(timer);
        resolveEndpoint(match[1]);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        rejectEndpoint(new Error(`Chrome exited before CDP was ready (${code}).\n${stderr}`));
      });
    });
    return { child, endpoint };
  } catch (error) {
    await stopChrome(child);
    throw error;
  }
}

async function stopChrome(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(3000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Runtime evaluation failed.');
  }
  return result.result.value;
}

async function runFixture(client, baseUrl, fixturePath, viewport) {
  const { browserContextId } = await client.send('Target.createBrowserContext');
  let targetId;
  try {
    ({ targetId } = await client.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    }));
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    }, sessionId);
    await client.send('Page.navigate', { url: `${baseUrl}/${fixturePath}` }, sessionId);

    const deadline = Date.now() + 25000;
    let result = '';
    while (!result && Date.now() < deadline) {
      await delay(50);
      result = await evaluate(client, sessionId, 'document.body?.dataset.testResult || ""');
    }
    if (!result) throw new Error('Fixture timed out without reporting a result.');
    if (result !== 'passed') {
      const error = await evaluate(client, sessionId,
        'document.body?.dataset.testError || "Fixture reported failure."');
      throw new Error(error);
    }
    const details = await evaluate(client, sessionId, 'document.body?.dataset.testDetails || ""');
    console.log(`passed ${fixturePath} (${viewport.name})${details ? '' : ' [no details]'}`);
  } finally {
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => undefined);
    await client.send('Target.disposeBrowserContext', { browserContextId }).catch(() => undefined);
  }
}

for (const fixturePath of fixturePaths) {
  try {
    await access(resolve(root, fixturePath));
  } catch {
    throw new Error(`Missing fixture: ${fixturePath}`);
  }
}

const chrome = await findChrome();
const profileDirectory = await mkdtemp(resolve(tmpdir(), 'web-audio-download-scripts-'));
const server = await startStaticServer();
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
let chromeProcess;
let client;

try {
  const started = await startChrome(chrome, profileDirectory);
  chromeProcess = started.child;
  client = await CdpClient.connect(started.endpoint);
  for (const fixturePath of fixturePaths) {
    for (const viewport of viewports) {
      await runFixture(client, baseUrl, fixturePath, viewport);
    }
  }
} finally {
  client?.close();
  if (chromeProcess) await stopChrome(chromeProcess);
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profileDirectory, { recursive: true, force: true });
}
