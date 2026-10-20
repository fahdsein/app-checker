import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = join(root, 'public');
const port = numberFromEnv('PORT', 3000, 1, 65535);
const requestTimeoutMs = numberFromEnv('CHECK_TIMEOUT_MS', 5000, 500, 15000);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function numberFromEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function redisConfiguration() {
  return {
    host: process.env.REDIS_HOST?.trim() || '',
    port: numberFromEnv('REDIS_PORT', 6379, 1, 65535),
    username: process.env.REDIS_USERNAME?.trim() || '',
    password: process.env.REDIS_PASSWORD || '',
    tls: /^(1|true|yes)$/i.test(process.env.REDIS_TLS || '')
  };
}

function encodeCommand(parts) {
  const values = parts.map((part) => Buffer.from(String(part)));
  const chunks = [Buffer.from(`*${values.length}\r\n`)];
  for (const value of values) {
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

function parseResponse(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset + 1);
  if (lineEnd === -1) return null;
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;

  if (type === '+') return { value: line, offset: next };
  if (type === '-') return { value: new Error(line), offset: next };
  if (type === ':') return { value: Number(line), offset: next };
  if (type === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, offset: next };
    if (buffer.length < next + length + 2) return null;
    return {
      value: buffer.toString('utf8', next, next + length),
      offset: next + length + 2
    };
  }
  throw new Error(`Unsupported Redis response type: ${type}`);
}

function runRedisCommands(config, commands) {
  return new Promise((resolve, reject) => {
    const options = { host: config.host, port: config.port };
    const socket = config.tls
      ? tls.connect({ ...options, servername: config.host })
      : net.createConnection(options);
    const responses = [];
    let pending = Buffer.alloc(0);
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    socket.setTimeout(requestTimeoutMs, () => finish(new Error(`Timed out after ${requestTimeoutMs} ms`)));
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => socket.write(Buffer.concat(commands.map(encodeCommand))));
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        let offset = 0;
        while (offset < pending.length) {
          const parsed = parseResponse(pending, offset);
          if (!parsed) break;
          responses.push(parsed.value);
          offset = parsed.offset;
        }
        pending = pending.subarray(offset);
        if (responses.length === commands.length) {
          const redisError = responses.find((value) => value instanceof Error);
          finish(redisError || null, responses);
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function checkRedis() {
  const config = redisConfiguration();
  if (!config.host) {
    return {
      ok: false,
      status: 'not_configured',
      message: 'Set REDIS_HOST on this Web Service before running the check.'
    };
  }

  const startedAt = performance.now();
  const key = `neoapp:app-checker:${crypto.randomUUID()}`;
  const value = `ok-${Date.now()}`;
  const commands = [];

  if (config.password) {
    commands.push(config.username
      ? ['AUTH', config.username, config.password]
      : ['AUTH', config.password]);
  }
  commands.push(
    ['PING'],
    ['SET', key, value, 'EX', '30'],
    ['GET', key],
    ['DEL', key]
  );

  try {
    const responses = await runRedisCommands(config, commands);
    const checkOffset = config.password ? 1 : 0;
    const ping = responses[checkOffset];
    const written = responses[checkOffset + 1];
    const read = responses[checkOffset + 2];
    const deleted = responses[checkOffset + 3];
    const ok = ping === 'PONG' && written === 'OK' && read === value && deleted === 1;

    return {
      ok,
      status: ok ? 'passed' : 'failed',
      message: ok ? 'Redis passed connectivity and temporary write/read/delete checks.' : 'Redis replied, but the functional check did not match expectations.',
      latencyMs: Math.round(performance.now() - startedAt),
      target: `${config.host}:${config.port}`,
      tls: config.tls,
      steps: [
        { name: 'PING', ok: ping === 'PONG' },
        { name: 'Temporary SET', ok: written === 'OK' },
        { name: 'GET verification', ok: read === value },
        { name: 'Cleanup DEL', ok: deleted === 1 }
      ]
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      message: error instanceof Error ? error.message : 'Redis check failed.',
      latencyMs: Math.round(performance.now() - startedAt),
      target: `${config.host}:${config.port}`,
      tls: config.tls
    };
  }
}

async function serveStatic(pathname, response) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(relativePath)) {
    json(response, 404, { error: 'Not found' });
    return;
  }
  try {
    const file = await readFile(join(publicRoot, relativePath));
    response.writeHead(200, {
      'content-type': mimeTypes[extname(relativePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    });
    response.end(file);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');

  if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
    json(response, 200, { status: 'ok', service: 'app-checker' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/checks') {
    const redis = redisConfiguration();
    json(response, 200, {
      checks: [{
        id: 'redis',
        name: 'Redis',
        description: 'Private TCP connectivity plus temporary write/read/delete verification.',
        configured: Boolean(redis.host),
        target: redis.host ? `${redis.host}:${redis.port}` : null,
        tls: redis.tls
      }]
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/check/redis') {
    const result = await checkRedis();
    json(response, result.ok ? 200 : 503, result);
    return;
  }

  if (request.method === 'GET') {
    await serveStatic(url.pathname, response);
    return;
  }

  json(response, 405, { error: 'Method not allowed' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`app-checker listening on 0.0.0.0:${port}`);
});
