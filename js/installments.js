// ==========================================================
// installments.js — prestações (compras parceladas)
// Responsabilidade: criar a compra, gerar as parcelas, marcar como
// paga/pendente e listar atrasadas e próximas.
//
// Estruturas:
//   InstallmentPlan (a compra):
//     id, description, totalAmountCents, installmentCount,
//     purchaseDate, firstDueDate, category, createdAt
//   Installment (cada parcela):
//     id, planId, number (1, 2, 3...), amountCents, dueDate,
//     paid (true/false), paidAt (data do pagamento ou null)
//
// COMO A PARCELA ENTRA NO TOTAL DE GASTOS (sem duplicar)
//   - Parcela pendente: não entra em nenhuma soma de gastos.
//   - Ao PAGAR: numa única transação, a parcela vira paid=true E é
//     criada uma despesa (data = dia do pagamento) ligada a ela por
//     sourceKey = "installment:<id da parcela>".
//   - Ao DESFAZER o pagamento: a parcela volta a pendente E a despesa
//     ligada é apagada, na mesma transação.
//   Resultado: o total do mês nunca conta a mesma parcela duas vezes.
// ==========================================================

import {
  STORES,
  awaitRequest,
  withTransaction,
  getAllRecords,
} from './database.js';
import { CATEGORIES, criarRegistroDespesa } from './expenses.js';
import { hojeISO, isValidISODate, somarMeses } from './utils.js';

/** Máximo de parcelas aceito (10 anos). */
export const MAX_INSTALLMENTS = 120;

// ---------------------------------------------------------
// Funções puras (não mexem no banco; fáceis de testar)
// ---------------------------------------------------------

/**
 * Divide o total em `count` parcelas SEM perder centavos.
 * Ex.: R$ 100,00 em 3x -> [3334, 3333, 3333] (soma = 10000).
 * Os centavos que sobram da divisão vão, 1 por parcela, para as
 * primeiras parcelas.
 */
export function splitAmount(totalCents, count) {
  const base = Math.floor(totalCents / count);
  const resto = totalCents - base * count; // sempre entre 0 e count-1
  return Array.from({ length: count }, (_, i) => base + (i < resto ? 1 : 0));
}

/**
 * Datas de vencimento: mesmo dia de cada mês, a partir do 1º vencimento.
 * Se o mês não tem o dia (31 em fevereiro), usa o último dia do mês.
 * Cada data é calculada a partir da PRIMEIRA, para o dia não "encolher".
 */
export function buildDueDates(firstDueDate, count) {
  return Array.from({ length: count }, (_, i) => somarMeses(firstDueDate, i));
}

/** Confere os campos da compra e devolve uma versão limpa. */
export function validatePlanFields({
  description,
  totalAmountCents,
  installmentCount,
  purchaseDate,
  firstDueDate,
  category,
}) {
  const descricaoLimpa = String(description ?? '').trim();
  if (!descricaoLimpa) throw new Error('Informe o nome da compra.');

  if (!Number.isSafeInteger(totalAmountCents) || totalAmountCents <= 0) {
    throw new Error('O valor total deve ser maior que zero.');
  }

  if (
    !Number.isInteger(installmentCount) ||
    installmentCount < 1 ||
    installmentCount > MAX_INSTALLMENTS
  ) {
    throw new Error(`O número de parcelas deve ficar entre 1 e ${MAX_INSTALLMENTS}.`);
  }

  if (totalAmountCents < installmentCount) {
    throw new Error('O valor total é pequeno demais para essa quantidade de parcelas.');
  }

  if (!isValidISODate(purchaseDate)) throw new Error('Informe a data da compra.');
  if (!isValidISODate(firstDueDate)) throw new Error('Informe o vencimento da 1ª parcela.');

  if (!CATEGORIES.includes(category)) throw new Error('Categoria inválida: ' + category);

  return {
    description: descricaoLimpa,
    totalAmountCents,
    installmentCount,
    purchaseDate,
    firstDueDate,
    category,
  };
}

/** Confere o registro de UMA parcela (usado ao importar backup). */
export function validateInstallmentRecord(p) {
  if (!Number.isInteger(p.planId) || p.planId < 1) throw new Error('parcela sem compra válida');
  if (!Number.isInteger(p.number) || p.number < 1 || p.number > MAX_INSTALLMENTS) {
    throw new Error('número de parcela inválido');
  }
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new Error('valor de parcela inválido');
  if (!isValidISODate(p.dueDate)) throw new Error('vencimento inválido');
  if (typeof p.paid !== 'boolean') throw new Error('situação de pagamento inválida');
  if (p.paid && !isValidISODate(p.paidAt)) throw new Error('data de pagamento inválida');
  return {
    planId: p.planId,
    number: p.number,
    amountCents: p.amountCents,
    dueDate: p.dueDate,
    paid: p.paid,
    paidAt: p.paid ? p.paidAt : null,
  };
}

/**
 * Monta (sem gravar) a compra e a lista de parcelas.
 * Se a data da compra não vier, usa hoje; se o 1º vencimento não vier,
 * usa 1 mês depois da compra.
 */
export function buildPlan(dados) {
  const purchaseDate = dados.purchaseDate ?? hojeISO();
  const firstDueDate =
    dados.firstDueDate ?? (isValidISODate(purchaseDate) ? somarMeses(purchaseDate, 1) : undefined);

  const limpo = validatePlanFields({ ...dados, purchaseDate, firstDueDate });

  const valores = splitAmount(limpo.totalAmountCents, limpo.installmentCount);
  const datas = buildDueDates(limpo.firstDueDate, limpo.installmentCount);

  const installments = valores.map((amountCents, i) => ({
    number: i + 1,
    amountCents,
    dueDate: datas[i],
    paid: false,
    paidAt: null,
  }));

  return { plan: { ...limpo, createdAt: new Date().toISOString() }, installments };
}

/**
 * Situação de uma parcela em relação a `hoje`:
 *   'paid' (paga), 'overdue' (venceu e não foi paga), 'upcoming' (a vencer).
 * Vencer HOJE ainda é "a vencer": só atrasa a partir do dia seguinte.
 */
export function classifyInstallment(parcela, hoje = hojeISO()) {
  if (parcela.paid) return 'paid';
  return parcela.dueDate < hoje ? 'overdue' : 'upcoming';
}

// ---------------------------------------------------------
// Operações no banco
// ---------------------------------------------------------

/**
 * Cadastra a compra e gera TODAS as parcelas, numa única transação
 * (ou grava tudo, ou nada). Devolve o id da compra.
 */
export async function addInstallmentPlan(dados) {
  const { plan, installments } = buildPlan(dados);

  return withTransaction([STORES.PLANS, STORES.INSTALLMENTS], 'readwrite', async (stores) => {
    const planId = await awaitRequest(stores[STORES.PLANS].add(plan));
    await Promise.all(
      installments.map((p) => awaitRequest(stores[STORES.INSTALLMENTS].add({ ...p, planId })))
    );
    return planId;
  });
}

/**
 * Todas as compras (mais recente primeiro), cada uma com a lista de
 * parcelas em `installments` (ordenada pelo número) e `paidCount`.
 */
export async function listPlansWithInstallments() {
  const [planos, parcelas] = await Promise.all([
    getAllRecords(STORES.PLANS),
    getAllRecords(STORES.INSTALLMENTS),
  ]);

  const porPlano = new Map();
  for (const p of parcelas) {
    if (!porPlano.has(p.planId)) porPlano.set(p.planId, []);
    porPlano.get(p.planId).push(p);
  }

  return planos
    .map((plano) => {
      const lista = (porPlano.get(plano.id) ?? []).sort((a, b) => a.number - b.number);
      return {
        ...plano,
        installments: lista,
        paidCount: lista.filter((p) => p.paid).length,
      };
    })
    .sort((a, b) => b.id - a.id);
}

/**
 * Parcelas NÃO pagas de todas as compras, por vencimento (as mais
 * antigas primeiro). Cada item traz também o nome da compra,
 * `planInstallmentCount` e `status` ('overdue' ou 'upcoming').
 */
export async function listPendingInstallments(hoje = hojeISO()) {
  const [planos, parcelas] = await Promise.all([
    getAllRecords(STORES.PLANS),
    getAllRecords(STORES.INSTALLMENTS),
  ]);
  const planoPorId = new Map(planos.map((p) => [p.id, p]));

  return parcelas
    .filter((p) => !p.paid && planoPorId.has(p.planId))
    .map((p) => ({
      ...p,
      planDescription: planoPorId.get(p.planId).description,
      planInstallmentCount: planoPorId.get(p.planId).installmentCount,
      status: classifyInstallment(p, hoje),
    }))
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      return a.id - b.id;
    });
}

/** Números para o Dashboard e para o topo da tela Parcelas. */
export async function getInstallmentsSummary(hoje = hojeISO()) {
  const pendentes = await listPendingInstallments(hoje);
  const atrasadas = pendentes.filter((p) => p.status === 'overdue');
  const soma = (lista) => lista.reduce((total, p) => total + p.amountCents, 0);

  return {
    pendingCount: pendentes.length,
    pendingTotalCents: soma(pendentes),
    overdueCount: atrasadas.length,
    overdueTotalCents: soma(atrasadas),
    nextDue: pendentes[0] ?? null, // a de vencimento mais antigo (pode estar atrasada)
  };
}

/**
 * Marca a parcela como PAGA e cria a despesa correspondente (data =
 * `paidAt`, hoje por padrão). Tudo numa transação.
 */
export async function markInstallmentPaid(id, paidAt = hojeISO()) {
  if (!isValidISODate(paidAt)) throw new Error('Informe uma data de pagamento válida.');

  return withTransaction(
    [STORES.INSTALLMENTS, STORES.PLANS, STORES.EXPENSES],
    'readwrite',
    async (stores) => {
      const parcela = await awaitRequest(stores[STORES.INSTALLMENTS].get(id));
      if (!parcela) throw new Error('Parcela não encontrada.');
      if (parcela.paid) throw new Error('Esta parcela já está paga.');

      const plano = await awaitRequest(stores[STORES.PLANS].get(parcela.planId));
      if (!plano) throw new Error('Compra desta parcela não encontrada.');

      const atualizada = { ...parcela, paid: true, paidAt };
      await awaitRequest(stores[STORES.INSTALLMENTS].put(atualizada));

      // Segurança extra: se por algum motivo já existir uma despesa
      // ligada a esta parcela, apagamos antes. Nunca fica duplicada.
      await apagarDespesasDaParcela(stores[STORES.EXPENSES], parcela.id);

      const despesa = criarRegistroDespesa(
        {
          description: `${plano.description} (${parcela.number}/${plano.installmentCount})`,
          amountCents: parcela.amountCents,
          category: plano.category,
          date: paidAt,
        },
        { type: 'installment', id: parcela.id }
      );
      await awaitRequest(stores[STORES.EXPENSES].add(despesa));

      return atualizada;
    }
  );
}

/** Desfaz o pagamento: a parcela volta a pendente e a despesa ligada é apagada. */
export async function markInstallmentPending(id) {
  return withTransaction(
    [STORES.INSTALLMENTS, STORES.EXPENSES],
    'readwrite',
    async (stores) => {
      const parcela = await awaitRequest(stores[STORES.INSTALLMENTS].get(id));
      if (!parcela) throw new Error('Parcela não encontrada.');
      if (!parcela.paid) throw new Error('Esta parcela ainda não foi paga.');

      const atualizada = { ...parcela, paid: false, paidAt: null };
      await awaitRequest(stores[STORES.INSTALLMENTS].put(atualizada));
      await apagarDespesasDaParcela(stores[STORES.EXPENSES], parcela.id);
      return atualizada;
    }
  );
}

/**
 * Exclui a compra, todas as suas parcelas e as despesas geradas pelos
 * pagamentos já feitos (elas deixam de existir no histórico).
 * Devolve quantas parcelas e despesas foram removidas.
 */
export async function deleteInstallmentPlan(planId) {
  return withTransaction(
    [STORES.PLANS, STORES.INSTALLMENTS, STORES.EXPENSES],
    'readwrite',
    async (stores) => {
      const plano = await awaitRequest(stores[STORES.PLANS].get(planId));
      if (!plano) throw new Error('Compra não encontrada.');

      const parcelas = await awaitRequest(
        stores[STORES.INSTALLMENTS].index('planId').getAll(planId)
      );

      let despesasRemovidas = 0;
      for (const parcela of parcelas) {
        despesasRemovidas += await apagarDespesasDaParcela(stores[STORES.EXPENSES], parcela.id);
        await awaitRequest(stores[STORES.INSTALLMENTS].delete(parcela.id));
      }
      await awaitRequest(stores[STORES.PLANS].delete(planId));

      return { removedInstallments: parcelas.length, removedExpenses: despesasRemovidas };
    }
  );
}

// ---------- funções internas ----------

/** Apaga as despesas ligadas à parcela (via índice sourceKey). Devolve quantas. */
async function apagarDespesasDaParcela(storeDespesas, parcelaId) {
  const ligadas = await awaitRequest(
    storeDespesas.index('sourceKey').getAll(`installment:${parcelaId}`)
  );
  for (const despesa of ligadas) {
    await awaitRequest(storeDespesas.delete(despesa.id));
  }
  return ligadas.length;
}
