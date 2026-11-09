const form = document.querySelector('#task-form');
const titleInput = document.querySelector('#task-title');
const submitButton = document.querySelector('#submit-button');
const errorBox = document.querySelector('#error');
const counter = document.querySelector('#counter');
const loading = document.querySelector('#loading');
const empty = document.querySelector('#empty');
const list = document.querySelector('#task-list');
const template = document.querySelector('#task-template');

let tasks = [];
let pending = new Set();

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const message = payload?.error?.message ?? `Erro HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function render() {
  list.replaceChildren();

  const doneCount = tasks.filter((task) => task.done).length;
  counter.textContent =
    tasks.length === 0
      ? '0 tarefas'
      : `${doneCount} de ${tasks.length} concluída${tasks.length === 1 ? '' : 's'}`;
  empty.hidden = tasks.length !== 0;

  for (const task of tasks) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = task.id;
    node.classList.toggle('is-done', task.done);

    const toggle = node.querySelector('.task__toggle');
    toggle.checked = task.done;
    toggle.setAttribute('aria-label', `Concluir: ${task.title}`);
    toggle.addEventListener('change', () => toggleTask(task));

    node.querySelector('.task__title').textContent = task.title;

    const date = node.querySelector('.task__date');
    date.dateTime = task.createdAt;
    date.textContent = formatDate(task.createdAt);

    const removeButton = node.querySelector('.task__delete');
    removeButton.addEventListener('click', () => removeTask(task, removeButton));

    list.append(node);
  }
}

function setBusy(id, busy) {
  if (busy) pending.add(id);
  else pending.delete(id);
}

async function loadTasks() {
  loading.hidden = false;
  try {
    tasks = await api('/api/tasks');
    clearError();
  } catch (error) {
    showError(`Não foi possível carregar as tarefas: ${error.message}`);
    tasks = [];
  } finally {
    loading.hidden = true;
    render();
  }
}

async function toggleTask(task) {
  if (pending.has(task.id)) return;
  setBusy(task.id, true);
  try {
    const updated = await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ done: !task.done }),
    });
    tasks = tasks.map((item) => (item.id === updated.id ? updated : item));
    clearError();
    render();
  } catch (error) {
    showError(`Não foi possível atualizar a tarefa: ${error.message}`);
    render();
  } finally {
    setBusy(task.id, false);
  }
}

async function removeTask(task, button) {
  if (pending.has(task.id)) return;
  setBusy(task.id, true);
  button.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
    tasks = tasks.filter((item) => item.id !== task.id);
    clearError();
    render();
  } catch (error) {
    button.disabled = false;
    showError(`Não foi possível remover a tarefa: ${error.message}`);
  } finally {
    setBusy(task.id, false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = titleInput.value.trim();
  if (title.length === 0) {
    showError('Digite um título para a tarefa.');
    titleInput.focus();
    return;
  }

  submitButton.disabled = true;
  try {
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    tasks = [...tasks, task];
    titleInput.value = '';
    clearError();
    render();
    titleInput.focus();
  } catch (error) {
    showError(`Não foi possível criar a tarefa: ${error.message}`);
  } finally {
    submitButton.disabled = false;
  }
});

loadTasks();
