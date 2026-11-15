// ==========================================================
// expenses.js — despesas
// Responsabilidade: regras de gastos (validar, adicionar, listar,
// editar, excluir, somar). Usa o database.js para gravar.
//
// Campos de uma despesa:
//   id, description, amountCents, category, date, createdAt
//   + (só quando veio de uma parcela paga)
//   sourceType ("installment"), sourceId (id da parcela),
//   sourceKey ("installment:12", usado como índice)
//
// REGRA ANTI-DUPLICAÇÃO: o total do mês soma SOMENTE despesas.
// Parcelas pendentes não entram em lugar nenhum da soma. Quando uma
// parcela é paga, o installments.js cria UMA despesa ligada a ela
// (sourceKey); ao desfazer o pagamento, essa despesa é apagada.
// Assim cada parcela aparece no total no máximo uma vez.
//
// Valores em CENTAVOS (inteiros). Datas como "AAAA-MM-DD".
// ==========================================================

import {
  STORES,
  addRecord,
  getRecord,
  getAllRecords,
  getRecordsByIndex,
  updateRecord,
  deleteRecord,
} from './database.js';
import { hojeISO, isValidISODate, deslocarMes } from './utils.js';

// Categorias iniciais. Para criar uma nova, é só acrescentar aqui.
export const CATEGORIES = [
  'Alimentação',
  'Transporte',
  'Moradia',
  'Lazer',
  'Saúde',
  'Educação',
  'Outros',
];

/**
 * Confere os campos de uma despesa e devolve uma versão "limpa".
 * Validar ANTES de gravar evita lixo no banco (ex.: valor negativo).
 * As mensagens são escritas para o usuário final ler.
 */
export function validateExpenseFields({ description, amountCents, category, date }) {
  const descricaoLimpa = String(description ?? '').trim();
  if (!descricaoLimpa) {
    throw new Error('Informe uma descrição.');
  }

  // amountCents precisa ser inteiro (centavos) e positivo
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('O valor deve ser maior que zero.');
  }

  if (!CATEGORIES.includes(category)) {
    throw new Error('Categoria inválida: ' + category);
  }

  if (!isValidISODate(date)) {
    throw new Error('Informe uma data válida.');
  }

  return { description: descricaoLimpa, amountCents, category, date };
}

/**
 * Monta (sem gravar) o registro de uma despesa, já validado.
 * `origem` é opcional: { type: 'installment', id: 12 } liga a despesa
 * à sua parcela de origem. É exportada para o installments.js criar a
 * despesa DENTRO da mesma transação que marca a parcela como paga.
 */
export function criarRegistroDespesa(dados, origem = null) {
  const registro = {
    ...validateExpenseFields(dados),
    createdAt: new Date().toISOString(), // quando foi registrada
  };
  if (origem) {
    registro.sourceType = origem.type;
    registro.sourceId = origem.id;
    registro.sourceKey = `${origem.type}:${origem.id}`;
  }
  return registro;
}

/** true se a despesa foi gerada pelo pagamento de uma parcela. */
export function isLinkedExpense(despesa) {
  return Boolean(despesa && despesa.sourceKey);
}

const MSG_VINCULADA =
  'Este gasto foi gerado ao pagar uma parcela. Para alterá-lo, use a tela Parcelas.';

/**
 * Cadastra uma despesa. Devolve o id gerado.
 * Exemplo:
 *   await addExpense({ description: 'Almoço', amountCents: 2590,
 *                      category: 'Alimentação', date: '2026-11-06' })
 */
export async function addExpense({
  description,
  amountCents,
  category = 'Outros',
  date = hojeISO(),
}) {
  const registro = criarRegistroDespesa({ description, amountCents, category, date });
  return addRecord(STORES.EXPENSES, registro);
}

/** Busca uma despesa pelo id. */
export function getExpense(id) {
  return getRecord(STORES.EXPENSES, id);
}

/** Lista todas as despesas, da mais recente para a mais antiga. */
export async function listExpenses() {
  const todas = await getAllRecords(STORES.EXPENSES);
  return ordenarMaisRecentesPrimeiro(todas);
}

/** As `limite` despesas mais recentes (para o "Últimos lançamentos"). */
export async function listRecentExpenses(limite = 5) {
  return (await listExpenses()).slice(0, limite);
}

/**
 * Lista as despesas de um mês, ex.: listExpensesByMonth('2026-11').
 *
 * Como funciona: como a data é texto "AAAA-MM-DD", a ordem alfabética
 * é igual à ordem cronológica. Então "do dia 2026-11-01 até 2026-11-31"
 * pega o mês inteiro (não existe dia 31 em alguns meses, mas isso não
 * atrapalha: nenhuma data válida fica fora desse intervalo).
 */
export async function listExpensesByMonth(anoMes) {
  conferirAnoMes(anoMes);
  const intervalo = IDBKeyRange.bound(`${anoMes}-01`, `${anoMes}-31`);
  const doMes = await getRecordsByIndex(STORES.EXPENSES, 'date', intervalo);
  return ordenarMaisRecentesPrimeiro(doMes);
}

/**
 * Resumo do mês: total gasto (em centavos) e quantidade de despesas.
 * É isso que o Dashboard mostra.
 */
export async function getMonthSummary(anoMes) {
  const despesas = await listExpensesByMonth(anoMes);
  const totalCents = despesas.reduce((soma, d) => soma + d.amountCents, 0);
  return { totalCents, count: despesas.length };
}

/**
 * Total por categoria no mês, do maior para o menor.
 * Devolve [{ category: 'Alimentação', totalCents: 12345 }, ...]
 */
export async function getCategoryTotals(anoMes) {
  const despesas = await listExpensesByMonth(anoMes);
  const soma = new Map();
  for (const d of despesas) {
    soma.set(d.category, (soma.get(d.category) ?? 0) + d.amountCents);
  }
  return [...soma.entries()]
    .map(([category, totalCents]) => ({ category, totalCents }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

/**
 * Total de cada um dos últimos `quantidade` meses, terminando em
 * `anoMesFinal` (inclusive), do mais antigo para o mais novo.
 * Meses sem gastos aparecem com total 0. Usa UMA consulta só.
 */
export async function getMonthlyTotals(anoMesFinal, quantidade = 6) {
  conferirAnoMes(anoMesFinal);
  const inicio = deslocarMes(anoMesFinal, -(quantidade - 1));
  const intervalo = IDBKeyRange.bound(`${inicio}-01`, `${anoMesFinal}-31`);
  const lista = await getRecordsByIndex(STORES.EXPENSES, 'date', intervalo);

  const meses = Array.from({ length: quantidade }, (_, i) => deslocarMes(inicio, i));
  const soma = new Map(meses.map((m) => [m, 0]));
  for (const d of lista) {
    const mes = d.date.slice(0, 7);
    soma.set(mes, (soma.get(mes) ?? 0) + d.amountCents);
  }
  return meses.map((anoMes) => ({ anoMes, totalCents: soma.get(anoMes) }));
}

/**
 * Edita uma despesa. Só precisa mandar os campos que mudam:
 *   await updateExpense(3, { amountCents: 3000 })
 * Despesas geradas por parcelas não podem ser editadas aqui.
 */
export async function updateExpense(id, mudancas) {
  const atual = await getRecord(STORES.EXPENSES, id);
  if (!atual) {
    throw new Error('Despesa não encontrada.');
  }
  if (isLinkedExpense(atual)) {
    throw new Error(MSG_VINCULADA);
  }

  // {...atual, ...mudancas} copia 'atual' e sobrescreve só o que veio em 'mudancas'
  const novosDados = validateExpenseFields({ ...atual, ...mudancas });

  // Mantemos id e createdAt originais
  const atualizada = { ...atual, ...novosDados };
  await updateRecord(STORES.EXPENSES, atualizada);
  return atualizada;
}

/**
 * Exclui uma despesa pelo id. Devolve o registro excluído (a tela usa
 * isso para oferecer "Desfazer"). Despesas geradas por parcelas só
 * saem desfazendo o pagamento na tela Parcelas.
 */
export async function deleteExpense(id) {
  const atual = await getRecord(STORES.EXPENSES, id);
  if (!atual) {
    throw new Error('Despesa não encontrada.');
  }
  if (isLinkedExpense(atual)) {
    throw new Error(MSG_VINCULADA);
  }
  await deleteRecord(STORES.EXPENSES, id);
  return atual;
}

/** Recoloca uma despesa excluída (mesmo id). Usado pelo "Desfazer". */
export function restoreExpense(registro) {
  return updateRecord(STORES.EXPENSES, registro);
}

// ---------- funções internas ----------

function conferirAnoMes(anoMes) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(anoMes)) {
    throw new Error('Mês inválido. Use o formato AAAA-MM, ex.: 2026-11');
  }
}

function ordenarMaisRecentesPrimeiro(lista) {
  // Ordena pela data (texto) e, em empate, pelo id: maior primeiro
  return [...lista].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.id - a.id;
  });
}
