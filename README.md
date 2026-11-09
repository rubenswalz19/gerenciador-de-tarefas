# Gerenciador de Tarefas

Aplicação web de tarefas com API HTTP e interface em HTML/CSS/JS, feita **apenas com módulos nativos do Node.js 22** — sem dependências externas.

## Requisitos

- Node.js 22 ou superior
- npm (opcional, apenas para os scripts)

## Como rodar

```powershell
npm.cmd start
```

Acesse <http://localhost:3000>.

Variáveis de ambiente opcionais:

| Variável    | Padrão       | Descrição                                  |
| ----------- | ------------ | ------------------------------------------ |
| `PORT`      | `3000`       | Porta HTTP                                 |
| `DATA_FILE` | `./data.json` | Caminho do arquivo de persistência         |

Exemplo em outra porta:

```powershell
$env:PORT = "3210"; npm.cmd start
```

## Testes

```powershell
npm.cmd test
```

Os testes usam `node:test` e cobrem:

- CRUD completo no store, validações, concorrência e persistência atômica;
- servidor HTTP real em porta efêmera: interface, CRUD via HTTP e respostas de erro;
- recusa de arquivo `data.json` malformado.

Smoke test opcional contra um servidor em execução:

```powershell
$env:BASE_URL = "http://127.0.0.1:3210"; npm.cmd run smoke
```

## API

| Método   | Rota             | Corpo                     | Sucesso              |
| -------- | ---------------- | ------------------------- | -------------------- |
| `GET`    | `/api/tasks`     | —                         | `200` array de tarefas |
| `POST`   | `/api/tasks`     | `{ "title": "..." }`      | `201` tarefa criada  |
| `PATCH`  | `/api/tasks/:id` | `{ "title"?: "...", "done"?: true }` | `200` tarefa atualizada |
| `DELETE` | `/api/tasks/:id` | —                         | `204` sem corpo      |

Tarefa retornada:

```json
{
  "id": "7f3c...",
  "title": "Comprar café",
  "done": false,
  "createdAt": "2026-11-09T12:00:00.000Z",
  "updatedAt": "2026-11-09T12:00:00.000Z"
}
```

Erros:

```json
{ "error": { "code": "validation_error", "message": "\"title\" não pode ser vazio." } }
```

Códigos usados: `invalid_json`, `invalid_body`, `validation_error`, `unsupported_media_type` (415), `payload_too_large` (413), `task_not_found` (404), `not_found` (404), `method_not_allowed` (405), `internal_error` (500).

Regras de validação:

- `title`: string, após `trim` entre 1 e 200 caracteres; campos desconhecidos são rejeitados.
- `done`: booleano.
- `PATCH` exige ao menos um dos campos `title` ou `done`.
- Requisições com corpo exigem `Content-Type: application/json`.

## Persistência

As tarefas ficam em `data.json` na raiz do projeto (ignorado pelo Git). A gravação usa arquivo temporário + `fsync` + `rename` atômico, com nova tentativa em erros transitórios do Windows (`EPERM`, `EACCES`, `EBUSY`). Operações são serializadas para evitar perda de dados em requisições concorrentes.

## Estrutura

```text
.
├── server.js              # bootstrap HTTP
├── src/
│   ├── app.js             # rotas, validação da requisição e erros
│   ├── store.js           # domínio + persistência atômica
│   └── public/
│       ├── index.html
│       ├── app.css
│       └── app.js
├── test/
│   ├── store.test.js
│   └── http.test.js
├── scripts/smoke.mjs
└── package.json
```
