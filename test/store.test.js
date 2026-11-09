import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NotFoundError, TaskStore, ValidationError } from '../src/store.js';

let directory;
let dataFile;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'tasks-store-'));
  dataFile = path.join(directory, 'data.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function readData() {
  return JSON.parse(await readFile(dataFile, 'utf8'));
}

describe('TaskStore', () => {
  it('cria data.json vazio quando o arquivo não existe', async () => {
    const store = await new TaskStore(dataFile).init();
    assert.deepEqual(store.list(), []);
    assert.deepEqual(await readData(), []);
  });

  it('cria tarefas e persiste entre instâncias', async () => {
    const store = await new TaskStore(dataFile).init();
    const task = await store.create({ title: '  Escrever testes  ' });

    assert.equal(task.title, 'Escrever testes');
    assert.equal(task.done, false);
    assert.match(task.id, /^[0-9a-f-]{36}$/);
    assert.equal(task.createdAt, task.updatedAt);

    const reloaded = await new TaskStore(dataFile).init();
    assert.deepEqual(reloaded.list(), [task]);
  });

  it('rejeita títulos inválidos sem gravar alterações', async () => {
    const store = await new TaskStore(dataFile).init();

    await assert.rejects(store.create({ title: '' }), ValidationError);
    await assert.rejects(store.create({ title: '   ' }), ValidationError);
    await assert.rejects(store.create({ title: 42 }), ValidationError);
    await assert.rejects(store.create({ title: 'x'.repeat(201) }), ValidationError);
    await assert.rejects(store.create({ title: 'ok', done: true }), ValidationError);
    await assert.rejects(store.create(null), ValidationError);
    await assert.rejects(store.create([]), ValidationError);

    assert.deepEqual(store.list(), []);
    assert.deepEqual(await readData(), []);
  });

  it('atualiza título e status, e valida o patch', async () => {
    const store = await new TaskStore(dataFile).init();
    const task = await store.create({ title: 'Tarefa original' });

    const renamed = await store.update(task.id, { title: 'Tarefa renomeada' });
    assert.equal(renamed.title, 'Tarefa renomeada');
    assert.equal(renamed.done, false);
    assert.ok(renamed.updatedAt >= task.updatedAt);

    const completed = await store.update(task.id, { done: true });
    assert.equal(completed.done, true);
    assert.equal(completed.title, 'Tarefa renomeada');

    await assert.rejects(store.update(task.id, {}), ValidationError);
    await assert.rejects(store.update(task.id, { done: 'sim' }), ValidationError);
    await assert.rejects(store.update(task.id, { title: '' }), ValidationError);
    await assert.rejects(store.update(task.id, { foo: 'bar' }), ValidationError);
    await assert.rejects(store.update('id-inexistente', { done: true }), NotFoundError);

    const reloaded = await new TaskStore(dataFile).init();
    assert.deepEqual(reloaded.list(), [completed]);
  });

  it('remove tarefas e informa erro para id inexistente', async () => {
    const store = await new TaskStore(dataFile).init();
    const first = await store.create({ title: 'Primeira' });
    const second = await store.create({ title: 'Segunda' });

    const removed = await store.remove(first.id);
    assert.deepEqual(removed, first);
    assert.deepEqual(store.list(), [second]);
    await assert.rejects(store.remove(first.id), NotFoundError);
    await assert.rejects(store.remove('outro-id'), NotFoundError);

    const reloaded = await new TaskStore(dataFile).init();
    assert.deepEqual(reloaded.list(), [second]);
  });

  it('serializa criações concorrentes sem perder dados', async () => {
    const store = await new TaskStore(dataFile).init();
    const titles = Array.from({ length: 25 }, (_, index) => `Tarefa ${index}`);
    await Promise.all(titles.map((title) => store.create({ title })));

    assert.equal(store.list().length, 25);
    const persisted = await readData();
    assert.equal(persisted.length, 25);
    assert.deepEqual(new Set(persisted.map((task) => task.title)), new Set(titles));

    const leftovers = (await readdir(directory)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('recusa arquivo de dados malformado', async () => {
    await writeFile(dataFile, '{ não é json', 'utf8');
    await assert.rejects(new TaskStore(dataFile).init(), /JSON malformado/);

    await writeFile(dataFile, JSON.stringify({ tasks: [] }), 'utf8');
    await assert.rejects(new TaskStore(dataFile).init(), /esperado um array/);

    await writeFile(dataFile, JSON.stringify([{ id: 'x', title: 'y' }]), 'utf8');
    await assert.rejects(new TaskStore(dataFile).init(), /"done" deve ser booleano/);
  });
});
