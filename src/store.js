import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_TITLE_LENGTH = 200;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Tarefa não encontrada') {
    super(message);
    this.name = 'NotFoundError';
  }
}

const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_ERRORS.has(error.code) || attempt >= attempts) {
        throw error;
      }
      await sleep(20 * attempt);
    }
  }
}

function validateTitle(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('"title" deve ser uma string.');
  }
  const title = value.trim();
  if (title.length === 0) {
    throw new ValidationError('"title" não pode ser vazio.');
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`"title" deve ter no máximo ${MAX_TITLE_LENGTH} caracteres.`);
  }
  return title;
}

function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('O corpo da requisição deve ser um objeto JSON.');
  }

  const allowed = new Set(['title', 'done']);
  const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ValidationError(`Campos não permitidos: ${unknown.join(', ')}.`);
  }

  const result = {};
  if (Object.hasOwn(patch, 'title')) {
    result.title = validateTitle(patch.title);
  }
  if (Object.hasOwn(patch, 'done')) {
    if (typeof patch.done !== 'boolean') {
      throw new ValidationError('"done" deve ser um booleano.');
    }
    result.done = patch.done;
  }
  if (Object.keys(result).length === 0) {
    throw new ValidationError('Informe ao menos um campo para atualizar: "title" ou "done".');
  }
  return result;
}

function normalizeStoredTask(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Item ${index} inválido: esperado um objeto.`);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error(`Item ${index} inválido: "id" ausente.`);
  }
  if (typeof raw.title !== 'string') {
    throw new Error(`Item ${index} inválido: "title" ausente.`);
  }
  if (typeof raw.done !== 'boolean') {
    throw new Error(`Item ${index} inválido: "done" deve ser booleano.`);
  }
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  return {
    id: raw.id,
    title: raw.title,
    done: raw.done,
    createdAt,
    updatedAt,
  };
}

/**
 * Armazena tarefas em memória e persiste em um arquivo JSON.
 * As operações são serializadas para evitar gravações concorrentes no mesmo arquivo.
 */
export class TaskStore {
  #tasks = [];
  #queue = Promise.resolve();
  #ready = false;

  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('TaskStore requer um caminho de arquivo.');
    }
    this.file = path.resolve(filePath);
  }

  #enqueue(operation) {
    const run = this.#queue.then(operation);
    // A fila continua mesmo após uma operação falhar.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async init() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#tasks = [];
        this.#ready = true;
        await this.#persist(this.#tasks);
        return this;
      }
      throw new Error(`Falha ao ler "${this.file}": ${error.message}`, { cause: error });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Arquivo de dados inválido (JSON malformado) em "${this.file}".`, {
        cause: error,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Arquivo de dados inválido em "${this.file}": esperado um array.`);
    }

    try {
      this.#tasks = parsed.map(normalizeStoredTask);
    } catch (error) {
      throw new Error(`Arquivo de dados inválido em "${this.file}": ${error.message}`);
    }
    this.#ready = true;
    return this;
  }

  #assertReady() {
    if (!this.#ready) {
      throw new Error('TaskStore não inicializado: chame init() antes de usar.');
    }
  }

  #snapshot() {
    return this.#tasks.map((task) => ({ ...task }));
  }

  list() {
    this.#assertReady();
    return this.#snapshot();
  }

  create(input) {
    this.#assertReady();
    return this.#enqueue(async () => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new ValidationError('O corpo da requisição deve ser um objeto JSON.');
      }
      const unknown = Object.keys(input).filter((key) => key !== 'title');
      if (unknown.length > 0) {
        throw new ValidationError(`Campos não permitidos: ${unknown.join(', ')}.`);
      }
      const title = validateTitle(input.title);
      const now = new Date().toISOString();
      const task = { id: randomUUID(), title, done: false, createdAt: now, updatedAt: now };
      const next = [...this.#tasks, task];
      await this.#persist(next);
      this.#tasks = next;
      return { ...task };
    });
  }

  update(id, patch) {
    this.#assertReady();
    return this.#enqueue(async () => {
      if (typeof id !== 'string' || id.length === 0) {
        throw new NotFoundError();
      }
      const changes = validatePatch(patch);
      const index = this.#tasks.findIndex((task) => task.id === id);
      if (index === -1) {
        throw new NotFoundError();
      }
      const updated = {
        ...this.#tasks[index],
        ...changes,
        updatedAt: new Date().toISOString(),
      };
      const next = this.#tasks.map((task, i) => (i === index ? updated : task));
      await this.#persist(next);
      this.#tasks = next;
      return { ...updated };
    });
  }

  remove(id) {
    this.#assertReady();
    return this.#enqueue(async () => {
      const index = this.#tasks.findIndex((task) => task.id === id);
      if (typeof id !== 'string' || index === -1) {
        throw new NotFoundError();
      }
      const removed = { ...this.#tasks[index] };
      const next = this.#tasks.filter((_, i) => i !== index);
      await this.#persist(next);
      this.#tasks = next;
      return removed;
    });
  }

  async #persist(tasks) {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true });

    const temporary = path.join(
      directory,
      `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const contents = `${JSON.stringify(tasks, null, 2)}\n`;

    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await renameWithRetry(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new Error(`Falha ao gravar "${this.file}": ${error.message}`, { cause: error });
    }
  }
}
