/* Smoke test HTTP real. Uso: node scripts/smoke.mjs [baseUrl] */
import assert from 'node:assert/strict';

const baseUrl = process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:3210';
const title = `Smoke test ${new Date().toISOString()}`;
let createdId = null;

async function call(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text.length > 0 && (response.headers.get('content-type') ?? '').includes('application/json')) {
    body = JSON.parse(text);
  }
  return { response, body, text };
}

function jsonOptions(method, payload) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

try {
  const home = await call('/');
  assert.equal(home.response.status, 200, 'GET / deve responder 200');
  assert.match(home.response.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(home.text, /Gerenciador de Tarefas/);
  console.log('ok  GET / -> 200, HTML da interface');

  const initial = await call('/api/tasks');
  assert.equal(initial.response.status, 200);
  assert.ok(Array.isArray(initial.body), 'GET /api/tasks deve retornar um array');
  console.log(`ok  GET /api/tasks -> 200, ${initial.body.length} tarefa(s)`);

  const invalid = await call('/api/tasks', jsonOptions('POST', { title: '   ' }));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'validation_error');
  console.log('ok  POST /api/tasks inválido -> 400');

  const created = await call('/api/tasks', jsonOptions('POST', { title }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.title, title);
  assert.equal(created.body.done, false);
  createdId = created.body.id;
  console.log(`ok  POST /api/tasks -> 201 (id ${createdId})`);

  const listed = await call('/api/tasks');
  assert.ok(listed.body.some((task) => task.id === createdId));
  console.log('ok  GET /api/tasks contém a tarefa criada');

  const patched = await call(
    `/api/tasks/${encodeURIComponent(createdId)}`,
    jsonOptions('PATCH', { done: true, title: `${title} (editada)` }),
  );
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.done, true);
  assert.equal(patched.body.title, `${title} (editada)`);
  console.log('ok  PATCH /api/tasks/:id -> 200, título e status atualizados');

  const missing = await call(
    '/api/tasks/id-inexistente',
    jsonOptions('PATCH', { done: true }),
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'task_not_found');
  console.log('ok  PATCH /api/tasks/id-inexistente -> 404');

  const removed = await call(`/api/tasks/${encodeURIComponent(createdId)}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 204);
  createdId = null;

  const finalList = await call('/api/tasks');
  assert.ok(!finalList.body.some((task) => task.id === created.body.id));
  console.log('ok  DELETE /api/tasks/:id -> 204 e tarefa removida da listagem');

  console.log('\nSmoke test concluído com sucesso.');
} catch (error) {
  console.error('\nSmoke test falhou:', error);
  process.exitCode = 1;
} finally {
  if (createdId) {
    await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(createdId)}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
}
