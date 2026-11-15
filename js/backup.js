// ==========================================================
// backup.js — exportação, validação e restauração dos dados
// Responsabilidade: gerar um arquivo .json com TODOS os dados,
// conferir um arquivo de backup antes de aceitá-lo e restaurá-lo.
//
// Por que isso importa: os dados vivem só dentro do navegador do
// celular. Limpar os dados do site, desinstalar o Chrome ou trocar de
// aparelho apaga tudo. O backup é a sua cópia de segurança.
//
// Formato do arquivo:
//   {
//     "app": "meu-organizador",
//     "backupVersion": 1,
//     "exportedAt": "2026-11-06T22:10:00.000Z",
//     "data": {
//       "expenses": [...], "installmentPlans": [...],
//       "installments": [...], "events": [...]
//     }
//   }
//
// SEGURANÇA DA RESTAURAÇÃO: o arquivo é validado por inteiro ANTES de
// tocar no banco, e a troca dos dados acontece numa única transação
// (tudo ou nada). Se algo estiver errado, os dados atuais ficam intactos.
// ==========================================================

import { STORES, awaitRequest, withTransaction, countRecords } from './database.js';
import { CATEGORIES, validateExpenseFields } from './expenses.js';
import { validatePlanFields, validateInstallmentRecord } from './installments.js';
import { validateEventFields } from './calendar.js';

export const BACKUP_APP_ID = 'meu-organizador';
export const BACKUP_VERSION = 1;

/** Tamanho máximo aceito para um arquivo de backup (20 MB). */
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

const CHAVE_ULTIMO_BACKUP = 'mo.ultimoBackup';
const DIAS_PARA_LEMBRAR = 30;

// ---------------------------------------------------------
// Exportar
// ---------------------------------------------------------

/** Lê todas as stores (numa só transação) e devolve o objeto do backup. */
export async function exportData() {
  const nomes = [STORES.EXPENSES, STORES.PLANS, STORES.INSTALLMENTS, STORES.EVENTS];

  const data = await withTransaction(nomes, 'readonly', async (stores) => {
    const [expenses, installmentPlans, installments, events] = await Promise.all(
      nomes.map((nome) => awaitRequest(stores[nome].getAll()))
    );
    return { expenses, installmentPlans, installments, events };
  });

  return {
    app: BACKUP_APP_ID,
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/** Gera o arquivo e dispara o download no navegador. Devolve o nome do arquivo. */
export async function downloadBackup() {
  const backup = await exportData();
  const texto = JSON.stringify(backup, null, 2);
  const blob = new Blob([texto], { type: 'application/json' });
  const nome = `meu-organizador-backup-${dataLocalCurta()}.json`;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = nome;
  document.body.append(link);
  link.click();
  link.remove();
  // Liberamos a memória do arquivo temporário um instante depois
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);

  registrarBackupFeito();
  return nome;
}

// ---------------------------------------------------------
// Conferir (validar) um backup
// ---------------------------------------------------------

/**
 * Lê o TEXTO de um arquivo de backup e confere tudo. Se estiver tudo
 * certo, devolve { exportedAt, data, counts } com registros "limpos"
 * (só os campos conhecidos). Se algo estiver errado, lança um Error
 * com uma mensagem em português dizendo o quê.
 */
export function parseBackup(texto) {
  let bruto;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new Error('O arquivo não é um backup válido (não é um JSON legível).');
  }

  if (!bruto || typeof bruto !== 'object' || bruto.app !== BACKUP_APP_ID) {
    throw new Error('Este arquivo não é um backup do Meu Organizador.');
  }
  if (!Number.isInteger(bruto.backupVersion) || bruto.backupVersion > BACKUP_VERSION) {
    throw new Error('Este backup foi feito por uma versão mais nova do app. Atualize o app e tente de novo.');
  }
  const dados = bruto.data;
  if (!dados || typeof dados !== 'object') {
    throw new Error('O backup não contém dados.');
  }
  for (const nome of ['expenses', 'installmentPlans', 'installments', 'events']) {
    if (!Array.isArray(dados[nome])) {
      throw new Error(`O backup está incompleto: falta a lista "${nome}".`);
    }
  }

  // ----- compras -----
  const planos = limparLista('Compra parcelada', dados.installmentPlans, (r) => {
    const limpo = validatePlanFields({
      ...r,
      category: CATEGORIES.includes(r.category) ? r.category : 'Outros',
    });
    return { ...limpo, createdAt: textoOuAgora(r.createdAt) };
  });
  const idsPlanos = new Set(planos.map((p) => p.id));

  // ----- parcelas -----
  const parcelas = limparLista('Parcela', dados.installments, (r) => {
    const limpa = validateInstallmentRecord(r);
    if (!idsPlanos.has(limpa.planId)) {
      throw new Error('a compra desta parcela não existe no backup');
    }
    return limpa;
  });
  const idsParcelas = new Set(parcelas.map((p) => p.id));

  // ----- despesas -----
  const despesas = limparLista('Despesa', dados.expenses, (r) => {
    const limpa = validateExpenseFields({
      ...r,
      category: CATEGORIES.includes(r.category) ? r.category : 'Outros',
    });
    const registro = { ...limpa, createdAt: textoOuAgora(r.createdAt) };

    if (r.sourceKey !== undefined) {
      // Despesa ligada a uma parcela: a ligação precisa ser coerente.
      if (
        r.sourceType !== 'installment' ||
        !Number.isInteger(r.sourceId) ||
        r.sourceKey !== `installment:${r.sourceId}` ||
        !idsParcelas.has(r.sourceId)
      ) {
        throw new Error('a ligação com a parcela de origem está inválida');
      }
      registro.sourceType = r.sourceType;
      registro.sourceId = r.sourceId;
      registro.sourceKey = r.sourceKey;
    }
    return registro;
  });

  // ----- compromissos -----
  const eventos = limparLista('Compromisso', dados.events, (r) => {
    const limpo = validateEventFields(r);
    return { ...limpo, notified: r.notified === true, createdAt: textoOuAgora(r.createdAt) };
  });

  // Uma parcela só pode ter UMA despesa ligada (regra anti-duplicação)
  const chaves = despesas.map((d) => d.sourceKey).filter(Boolean);
  if (new Set(chaves).size !== chaves.length) {
    throw new Error('O backup tem despesas duplicadas para a mesma parcela.');
  }

  // Coerência de cada compra: quantidade, numeração e soma das parcelas
  for (const plano of planos) {
    const doPlano = parcelas.filter((p) => p.planId === plano.id).sort((a, b) => a.number - b.number);
    if (doPlano.length !== plano.installmentCount) {
      throw new Error(`A compra "${plano.description}" deveria ter ${plano.installmentCount} parcelas, mas o backup traz ${doPlano.length}.`);
    }
    if (doPlano.some((p, i) => p.number !== i + 1)) {
      throw new Error(`As parcelas da compra "${plano.description}" estão repetidas ou fora de ordem.`);
    }
    const soma = doPlano.reduce((total, p) => total + p.amountCents, 0);
    if (soma !== plano.totalAmountCents) {
      throw new Error(`A soma das parcelas da compra "${plano.description}" não bate com o valor total.`);
    }
  }

  // Parcela paga <=> existe exatamente um gasto ligado a ela.
  // Sem isso o total do mês ficaria errado e o gasto ficaria "preso".
  const parcelasComGasto = new Set(despesas.filter((d) => d.sourceKey).map((d) => d.sourceId));
  for (const p of parcelas) {
    if (p.paid && !parcelasComGasto.has(p.id)) {
      throw new Error('O backup tem uma parcela paga sem o gasto correspondente.');
    }
    if (!p.paid && parcelasComGasto.has(p.id)) {
      throw new Error('O backup tem um gasto ligado a uma parcela que está pendente.');
    }
  }

  return {
    exportedAt: typeof bruto.exportedAt === 'string' ? bruto.exportedAt : null,
    data: {
      expenses: despesas,
      installmentPlans: planos,
      installments: parcelas,
      events: eventos,
    },
    counts: {
      expenses: despesas.length,
      installmentPlans: planos.length,
      installments: parcelas.length,
      events: eventos.length,
    },
  };
}

// ---------------------------------------------------------
// Restaurar
// ---------------------------------------------------------

/**
 * SUBSTITUI todos os dados atuais pelos do backup já conferido
 * (resultado de parseBackup). Numa única transação: ou troca tudo,
 * ou não muda nada.
 */
export async function restoreBackup(backupConferido) {
  const { data, counts } = backupConferido;
  const nomes = [STORES.EXPENSES, STORES.PLANS, STORES.INSTALLMENTS, STORES.EVENTS];
  const porStore = {
    [STORES.EXPENSES]: data.expenses,
    [STORES.PLANS]: data.installmentPlans,
    [STORES.INSTALLMENTS]: data.installments,
    [STORES.EVENTS]: data.events,
  };

  await withTransaction(nomes, 'readwrite', async (stores) => {
    for (const nome of nomes) {
      await awaitRequest(stores[nome].clear());
      // Os registros trazem o próprio id, e o IndexedDB o respeita.
      // Os ids novos continuarão a partir do maior id restaurado.
      await Promise.all(porStore[nome].map((registro) => awaitRequest(stores[nome].add(registro))));
    }
  });

  return counts;
}

// ---------------------------------------------------------
// Controle de "quando foi o último backup"
// ---------------------------------------------------------

function registrarBackupFeito() {
  try {
    localStorage.setItem(CHAVE_ULTIMO_BACKUP, String(Date.now()));
  } catch {
    /* localStorage indisponível: apenas não lembraremos a data */
  }
}

/** Data (em ms) do último backup feito neste aparelho, ou null. */
export function getLastBackupAt() {
  try {
    const valor = Number(localStorage.getItem(CHAVE_ULTIMO_BACKUP));
    return Number.isFinite(valor) && valor > 0 ? valor : null;
  } catch {
    return null;
  }
}

/** true se existem dados e o último backup é inexistente ou tem mais de 30 dias. */
export async function backupIsDue(agora = Date.now()) {
  const contagens = await Promise.all(
    [STORES.EXPENSES, STORES.PLANS, STORES.EVENTS].map((nome) => countRecords(nome))
  );
  const temDados = contagens.some((n) => n > 0);
  if (!temDados) return false;

  const ultimo = getLastBackupAt();
  return ultimo === null || agora - ultimo > DIAS_PARA_LEMBRAR * 24 * 60 * 60 * 1000;
}

// ---------- funções internas ----------

/**
 * Valida cada item de uma lista. Confere também que cada um tem um
 * `id` inteiro positivo e que não há ids repetidos. Os erros dizem o
 * número do item para facilitar achar o problema.
 */
function limparLista(rotulo, lista, validarItem) {
  const ids = new Set();
  return lista.map((item, posicao) => {
    try {
      if (!item || typeof item !== 'object') throw new Error('registro inválido');
      if (!Number.isInteger(item.id) || item.id < 1) throw new Error('id inválido');
      if (ids.has(item.id)) throw new Error('id repetido');
      ids.add(item.id);
      return { id: item.id, ...validarItem(item) };
    } catch (erro) {
      throw new Error(`${rotulo} nº ${posicao + 1}: ${erro.message}`);
    }
  });
}

function textoOuAgora(valor) {
  return typeof valor === 'string' && valor ? valor : new Date().toISOString();
}

/** "AAAA-MM-DD" no horário local (para o nome do arquivo). */
function dataLocalCurta() {
  const d = new Date();
  const dois = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}
