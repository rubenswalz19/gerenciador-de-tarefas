import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { TaskStore } from './src/store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const dataFile = path.resolve(process.env.DATA_FILE ?? path.join(root, 'data.json'));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT inválida: "${process.env.PORT}". Use um inteiro entre 1 e 65535.`);
  process.exit(1);
}

const store = new TaskStore(dataFile);
try {
  await store.init();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const server = createServer(createApp({ store }));

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`A porta ${port} já está em uso.`);
  } else {
    console.error('Falha ao iniciar o servidor:', error);
  }
  process.exit(1);
});

server.listen(port, () => {
  console.log(`Gerenciador de Tarefas em http://localhost:${port}`);
  console.log(`Dados: ${dataFile}`);
});

function shutdown(signal) {
  console.log(`\nRecebido ${signal}, encerrando...`);
  server.close((error) => {
    if (error) {
      console.error('Erro ao encerrar o servidor:', error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
