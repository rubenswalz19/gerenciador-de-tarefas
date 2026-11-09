import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { TaskStore } from '../src/store.js';

let directory;
let dataFile;
let server;
let baseUrl;
const openSockets = new Set();

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, options);
}

async function requestJson(pathname, options = {}) {
  const response = await request(pathname, options);
  const text = await response.text();
  return {
    response,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

function postJson(pathname, payload) {
  return requestJson(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'tasks-http-'));
  dataFile = path.join(directory, 'data.json');
  const store = await new TaskStore(dataFile).init();
  server = createServer(createApp({ store }));

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) {
    for (const socket of openSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(directory, { recursive: true, force: true });
});

describe('HTTP', () => {
  it('serve a interface HTML, CSS e JS', async () => {
    const home = await request('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /^text\/html/);
    const html = await home.text();
    assert.match(html, /Gerenciador de Tarefas/);
    assert.match(html, /id="task-form"/);

    const css = await request('/app.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /^text\/css/);

    const js = await request('/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /^text\/javascript/);

    const head = await request('/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });

  it('exercita o CRUD completo de tarefas', async () => {
    const initial = await requestJson('/api/tasks');
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.body, []);

    const created = await postJson('/api/tasks', { title: '  Comprar café  ' });
    assert.equal(created.response.status, 201);
    assert.equal(created.response.headers.get('location'), `/api/tasks/${created.body.id}`);
    assert.equal(created.body.title, 'Comprar café');
    assert.equal(created.body.done, false);
    assert.equal(typeof created.body.id, 'string');

    const second = await postJson('/api/tasks', { title: 'Estudar Node.js' });
    assert.equal(second.response.status, 201);

    const listed = await requestJson('/api/tasks');
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.length, 2);
    assert.deepEqual(
      listed.body.map((task) => task.title),
      ['Comprar café', 'Estudar Node.js'],
    );

    const patched = await requestJson(`/api/tasks/${created.body.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true, title: 'Comprar café e leite' }),
    });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.body.title, 'Comprar café e leite');
    assert.equal(patched.body.done, true);

    const afterPatch = await requestJson('/api/tasks');
    assert.equal(afterPatch.body.find((task) => task.id === created.body.id).done, true);

    const deleted = await request(`/api/tasks/${created.body.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '');

    const afterDelete = await requestJson('/api/tasks');
    assert.equal(afterDelete.body.length, 1);
    assert.equal(afterDelete.body[0].id, second.body.id);

    const persisted = JSON.parse(await readFile(dataFile, 'utf8'));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, second.body.id);
  });

  it('valida entrada e devolve erros coerentes', async () => {
    const invalidTitles = [{}, { title: '' }, { title: '   ' }, { title: 123 }, { title: 'x'.repeat(201) }];
    for (const payload of invalidTitles) {
      const { response, body } = await postJson('/api/tasks', payload);
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal(body.error.code, 'validation_error');
    }

    const wrongType = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"title":"x"}',
    });
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json()).error.code, 'unsupported_media_type');

    const malformed = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid_json');

    const emptyBody = await request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(emptyBody.status, 400);
    assert.equal((await emptyBody.json()).error.code, 'invalid_body');

    const unknownId = await request('/api/tasks/nao-existe', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    assert.equal(unknownId.status, 404);
    assert.equal((await unknownId.json()).error.code, 'task_not_found');

    const deleteUnknown = await request('/api/tasks/nao-existe', { method: 'DELETE' });
    assert.equal(deleteUnknown.status, 404);

    const invalidPatch = await requestJson('/api/tasks/nao-existe', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: 'sim' }),
    });
    assert.equal(invalidPatch.response.status, 400);

    const methodNotAllowed = await request('/api/tasks', { method: 'PUT' });
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(methodNotAllowed.headers.get('allow'), 'GET, POST');

    const unknownRoute = await request('/api/desconhecida');
    assert.equal(unknownRoute.status, 404);
    assert.equal((await unknownRoute.json()).error.code, 'not_found');

    const tasks = await requestJson('/api/tasks');
    assert.equal(tasks.body.length, 1, 'erros não devem criar tarefas');
  });
});
