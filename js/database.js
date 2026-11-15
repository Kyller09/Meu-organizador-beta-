// ==========================================================
// database.js — gerenciamento do IndexedDB
// Responsabilidade: abrir o banco e oferecer funções GENÉRICAS
// (salvar, ler, editar, excluir). Este arquivo não sabe o que é
// uma "despesa" — quem sabe isso são os outros módulos.
//
// Vocabulário do IndexedDB:
//   - database (banco)      : o "arquivo" guardado dentro do navegador
//   - object store          : o equivalente a uma TABELA
//   - record (registro)     : um objeto JavaScript guardado na store
//   - index (índice)        : um atalho para buscar por um campo
//                             (ex.: achar despesas por data)
//   - transaction           : um "pacote" de operações; ou tudo dá
//                             certo, ou nada é gravado
//
// HISTÓRICO DE VERSÕES DO BANCO
//   v1: stores expenses, installmentPlans, installments, events
//   v2: índice 'sourceKey' em expenses (liga uma despesa à parcela
//       que a originou, para nunca contar a mesma parcela duas vezes)
// ==========================================================

const DB_NAME = 'meu-organizador';

// Versão do banco. Sempre que você mudar a ESTRUTURA (criar store ou
// índice novo), aumente este número e acrescente um bloco "if" na
// migração (onupgradeneeded). O navegador roda a migração uma vez.
const DB_VERSION = 2;

// Nomes das stores num lugar só, para não repetir texto "solto" pelo código
// (um erro de digitação em texto solto só aparece quando o app roda).
export const STORES = {
  EXPENSES: 'expenses',
  PLANS: 'installmentPlans',
  INSTALLMENTS: 'installments',
  EVENTS: 'events',
};

// Guardamos a "promessa" da conexão para abrir o banco UMA vez só.
let conexao = null;

/**
 * Abre (e, na primeira vez, cria ou migra) o banco.
 * Devolve uma Promise com o objeto do banco.
 */
export function openDatabase() {
  if (conexao) return conexao;

  conexao = new Promise((resolve, reject) => {
    const pedido = indexedDB.open(DB_NAME, DB_VERSION);

    // Roda quando o banco NÃO existe ainda (oldVersion = 0) ou quando
    // a versão sobe (ex.: de 1 para 2). É aqui, e só aqui, que se
    // criam stores e índices. Cada "if" aplica uma versão, em ordem,
    // então quem vem da v1 só recebe o que faltava, sem perder dados.
    pedido.onupgradeneeded = (evento) => {
      const db = pedido.result;
      const transacao = pedido.transaction; // transação especial de upgrade
      const versaoAntiga = evento.oldVersion;

      // ----- v1: estrutura inicial -----
      if (versaoAntiga < 1) {
        // keyPath 'id' + autoIncrement: o próprio banco gera 1, 2, 3...
        const despesas = db.createObjectStore(STORES.EXPENSES, {
          keyPath: 'id',
          autoIncrement: true,
        });
        despesas.createIndex('date', 'date'); // buscar por data/mês
        despesas.createIndex('category', 'category'); // buscar por categoria

        db.createObjectStore(STORES.PLANS, { keyPath: 'id', autoIncrement: true });

        const parcelas = db.createObjectStore(STORES.INSTALLMENTS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        parcelas.createIndex('planId', 'planId'); // parcelas de uma compra
        parcelas.createIndex('dueDate', 'dueDate'); // por vencimento

        const eventos = db.createObjectStore(STORES.EVENTS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        eventos.createIndex('date', 'date'); // compromissos por dia
      }

      // ----- v2: liga despesa -> parcela de origem -----
      if (versaoAntiga < 2) {
        // Para uma store que já existe, usamos a transação de upgrade.
        // Registros SEM o campo sourceKey simplesmente não entram no índice.
        transacao.objectStore(STORES.EXPENSES).createIndex('sourceKey', 'sourceKey');
      }
    };

    pedido.onsuccess = () => {
      const db = pedido.result;
      // Se outra aba precisar atualizar o banco, fechamos esta conexão
      // para não travar a atualização.
      db.onversionchange = () => {
        db.close();
        conexao = null;
      };
      resolve(db);
    };

    pedido.onblocked = () => {
      // Outra aba/janela do app, de uma versão antiga, está segurando o banco.
      // Avisamos por evento (o app.js mostra a mensagem na tela).
      console.warn('Atualização do banco bloqueada: feche outras abas do app.');
      document.dispatchEvent(new CustomEvent('banco-bloqueado'));
    };

    pedido.onerror = () => {
      conexao = null; // permite tentar de novo depois
      reject(pedido.error);
    };
  });

  return conexao;
}

/**
 * Transforma um "pedido" (request) do IndexedDB em Promise.
 * Útil dentro de withTransaction: `const x = await awaitRequest(store.get(1))`.
 */
export function awaitRequest(pedido) {
  return new Promise((resolve, reject) => {
    pedido.onsuccess = () => resolve(pedido.result);
    pedido.onerror = () => reject(pedido.error);
  });
}

/**
 * Executa várias operações, possivelmente em VÁRIAS stores, dentro de
 * UMA transação. Garante tudo-ou-nada: se qualquer passo falhar (ou se
 * a função lançar um erro), NADA é gravado.
 *
 * Exemplo: pagar uma parcela precisa (1) marcar a parcela como paga e
 * (2) criar a despesa. Se só um dos dois acontecesse, o total do mês
 * ficaria errado.
 *
 * @param {string[]} nomesStores - stores usadas
 * @param {'readonly'|'readwrite'} modo
 * @param {(stores: Object) => Promise<any>} trabalho - recebe { nomeDaStore: store }
 *
 * Importante: dentro de `trabalho` espere SOMENTE pedidos do IndexedDB
 * (awaitRequest). Se esperar outra coisa (fetch, setTimeout), a
 * transação fecha sozinha antes e dá erro.
 */
export async function withTransaction(nomesStores, modo, trabalho) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transacao = db.transaction(nomesStores, modo);
    const stores = {};
    for (const nome of nomesStores) {
      stores[nome] = transacao.objectStore(nome);
    }

    let resultado;

    // Só resolvemos no evento 'complete': o dado já foi confirmado (commit).
    transacao.oncomplete = () => resolve(resultado);
    transacao.onerror = (evento) => reject(evento.target?.error ?? transacao.error);
    transacao.onabort = () => reject(transacao.error ?? new Error('Operação cancelada.'));

    (async () => {
      try {
        resultado = await trabalho(stores);
      } catch (erro) {
        // Erro nosso (ex.: validação): cancela tudo e avisa quem chamou.
        try {
          transacao.abort();
        } catch {
          /* a transação já tinha terminado */
        }
        reject(erro);
      }
    })();
  });
}

/**
 * Função interna que executa UMA operação numa store.
 * Toda função pública abaixo usa esta, então a lógica de
 * "abrir transação, esperar terminar, tratar erro" fica em um lugar só.
 */
async function executar(nomeStore, modo, operacao) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transacao = db.transaction(nomeStore, modo);
    const store = transacao.objectStore(nomeStore);

    const pedido = operacao(store);
    let resultado;

    pedido.onsuccess = () => {
      resultado = pedido.result;
    };
    transacao.oncomplete = () => resolve(resultado);
    transacao.onerror = () => reject(transacao.error);
    transacao.onabort = () => reject(transacao.error);
  });
}

// ---------- CRUD genérico (Create, Read, Update, Delete) ----------

/** CREATE — grava um registro novo. Devolve o id gerado. */
export function addRecord(nomeStore, dados) {
  return executar(nomeStore, 'readwrite', (store) => store.add(dados));
}

/** READ — busca um registro pelo id (devolve undefined se não existir). */
export function getRecord(nomeStore, id) {
  return executar(nomeStore, 'readonly', (store) => store.get(id));
}

/** READ — devolve TODOS os registros da store, em ordem de id. */
export function getAllRecords(nomeStore) {
  return executar(nomeStore, 'readonly', (store) => store.getAll());
}

/** READ — quantos registros a store tem. */
export function countRecords(nomeStore) {
  return executar(nomeStore, 'readonly', (store) => store.count());
}

/**
 * READ — busca usando um índice.
 * `intervalo` é opcional (veja IDBKeyRange.bound() no expenses.js).
 */
export function getRecordsByIndex(nomeStore, nomeIndice, intervalo) {
  return executar(nomeStore, 'readonly', (store) =>
    store.index(nomeIndice).getAll(intervalo)
  );
}

/**
 * UPDATE — substitui o registro que tem o mesmo `id` (put).
 * O objeto precisa conter o campo `id`. Se o id não existir, o put
 * CRIA o registro com esse id — é assim que o "Desfazer" restaura
 * um item excluído.
 */
export function updateRecord(nomeStore, dados) {
  return executar(nomeStore, 'readwrite', (store) => store.put(dados));
}

/** DELETE — remove o registro com esse id. */
export function deleteRecord(nomeStore, id) {
  return executar(nomeStore, 'readwrite', (store) => store.delete(id));
}
