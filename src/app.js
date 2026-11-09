import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundError, ValidationError } from './store.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;

const STATIC_ROUTES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendError(res, 405, 'method_not_allowed', `Método não permitido. Use: ${allowed.join(', ')}.`);
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'Corpo da requisição excede 64 KB.');
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new HttpError(400, 'invalid_body', 'Corpo da requisição vazio.');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON malformado.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_body', 'O corpo deve ser um objeto JSON.');
  }
  return parsed;
}

async function serveStatic(req, res, route, publicDir) {
  const filePath = path.join(publicDir, route.file);
  let contents;
  try {
    contents = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HttpError(500, 'static_missing', 'Arquivo da interface não encontrado.');
    }
    throw error;
  }
  res.writeHead(200, {
    'Content-Type': route.type,
    'Content-Length': contents.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : contents);
}

/**
 * Cria o handler HTTP da aplicação.
 * @param {{ store: import('./store.js').TaskStore, publicDir?: string }} options
 */
export function createApp({ store, publicDir = DEFAULT_PUBLIC_DIR }) {
  if (!store) {
    throw new Error('createApp requer uma instância de store.');
  }

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { pathname } = url;
      const method = req.method ?? 'GET';

      if (pathname === '/api/tasks') {
        if (method === 'GET') {
          sendJson(res, 200, store.list());
          return;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          let task;
          try {
            task = await store.create(body);
          } catch (error) {
            if (error instanceof ValidationError) {
              throw new HttpError(400, 'validation_error', error.message);
            }
            throw error;
          }
          res.setHeader('Location', `/api/tasks/${task.id}`);
          sendJson(res, 201, task);
          return;
        }
        methodNotAllowed(res, ['GET', 'POST']);
        return;
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        let id;
        try {
          id = decodeURIComponent(taskMatch[1]);
        } catch {
          throw new HttpError(400, 'invalid_id', 'Identificador inválido na URL.');
        }

        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          let task;
          try {
            task = await store.update(id, body);
          } catch (error) {
            if (error instanceof ValidationError) {
              throw new HttpError(400, 'validation_error', error.message);
            }
            if (error instanceof NotFoundError) {
              throw new HttpError(404, 'task_not_found', error.message);
            }
            throw error;
          }
          sendJson(res, 200, task);
          return;
        }

        if (method === 'DELETE') {
          try {
            await store.remove(id);
          } catch (error) {
            if (error instanceof NotFoundError) {
              throw new HttpError(404, 'task_not_found', error.message);
            }
            throw error;
          }
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }

        methodNotAllowed(res, ['PATCH', 'DELETE']);
        return;
      }

      if (pathname.startsWith('/api/')) {
        throw new HttpError(404, 'not_found', 'Rota da API não encontrada.');
      }

      const staticRoute = STATIC_ROUTES.get(pathname);
      if (staticRoute) {
        if (method !== 'GET' && method !== 'HEAD') {
          methodNotAllowed(res, ['GET', 'HEAD']);
          return;
        }
        await serveStatic(req, res, staticRoute, publicDir);
        return;
      }

      throw new HttpError(404, 'not_found', 'Rota não encontrada.');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      console.error('Erro interno ao processar requisição:', error);
      sendError(res, 500, 'internal_error', 'Erro interno do servidor.');
    }
  };
}
