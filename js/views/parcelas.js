// ==========================================================
// views/parcelas.js — tela Parcelas
// Responsabilidade: cadastrar compra parcelada (com prévia do valor
// de cada parcela), listar atrasadas e próximas, pagar/desfazer e
// excluir compras. A regra está em installments.js.
// ==========================================================

import { CATEGORIES } from '../expenses.js';
import {
  MAX_INSTALLMENTS,
  addInstallmentPlan,
  listPendingInstallments,
  listPlansWithInstallments,
  markInstallmentPaid,
  markInstallmentPending,
  deleteInstallmentPlan,
  splitAmount,
  classifyInstallment,
} from '../installments.js';
import {
  reaisParaCentavos,
  centavosParaReais,
  hojeISO,
  somarMeses,
  isValidISODate,
  formatarData,
  diasEntre,
} from '../utils.js';
import {
  el,
  limpar,
  preencherSelect,
  mostrarErroForm,
  limparErroForm,
  mostrarToast,
  confirmar,
  tratarErro,
  avisarMudanca,
} from '../ui.js';

const $ = (id) => document.getElementById(id);

const MAX_PROXIMAS = 8; // quantas "próximas parcelas" mostrar de uma vez

let sequencia = 0;
let vencimentoManual = false; // true se o usuário mexeu no 1º vencimento
let planosAtuais = new Map(); // id -> compra (da última renderização)
const abertos = new Set(); // ids das compras com o <details> aberto

export function iniciarParcelas() {
  preencherSelect($('parcela-categoria'), CATEGORIES.map((c) => ({ value: c, label: c })), CATEGORIES[0]);
  definirDatasPadrao();

  $('parcela-compra').addEventListener('input', () => {
    const compra = $('parcela-compra').value;
    if (!vencimentoManual && isValidISODate(compra)) {
      $('parcela-vencimento').value = somarMeses(compra, 1);
    }
  });
  $('parcela-vencimento').addEventListener('input', () => {
    vencimentoManual = true;
  });
  $('parcela-valor').addEventListener('input', atualizarPrevia);
  $('parcela-qtd').addEventListener('input', atualizarPrevia);
  $('form-parcela').addEventListener('submit', cadastrar);

  $('tela-parcelas').addEventListener('click', aoClicar);

  // O evento "toggle" não borbulha, por isso usamos a fase de captura
  $('lista-compras').addEventListener(
    'toggle',
    (evento) => {
      const detalhe = evento.target;
      if (!detalhe.matches?.('details[data-plan-id]')) return;
      const id = Number(detalhe.dataset.planId);
      if (detalhe.open) abertos.add(id);
      else abertos.delete(id);
    },
    true
  );
}

function definirDatasPadrao() {
  const hoje = hojeISO();
  $('parcela-compra').value = hoje;
  $('parcela-vencimento').value = somarMeses(hoje, 1);
  vencimentoManual = false;
}

/** Texto do tipo "12x de R$ 83,33" ou "2x de R$ 33,34 e 1x de R$ 33,33". */
export function descreverParcelas(totalCents, quantidade) {
  const valores = splitAmount(totalCents, quantidade);
  const maior = valores[0];
  const menor = valores[valores.length - 1];
  if (maior === menor) return `${quantidade}x de ${centavosParaReais(maior)}`;
  const qtdMaior = valores.filter((v) => v === maior).length;
  return `${qtdMaior}x de ${centavosParaReais(maior)} e ${quantidade - qtdMaior}x de ${centavosParaReais(menor)}`;
}

function atualizarPrevia() {
  const alvo = $('parcela-previa');
  try {
    const total = reaisParaCentavos($('parcela-valor').value);
    const qtd = Number($('parcela-qtd').value);
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > MAX_INSTALLMENTS || total < qtd) {
      alvo.textContent = '';
      return;
    }
    alvo.textContent = descreverParcelas(total, qtd);
  } catch {
    alvo.textContent = ''; // valor ainda incompleto: sem prévia
  }
}

async function cadastrar(evento) {
  evento.preventDefault();
  const erro = $('parcela-erro');
  const botao = evento.target.querySelector('button[type="submit"]');
  if (botao.disabled) return;
  botao.disabled = true;
  limparErroForm(erro);

  try {
    const planId = await addInstallmentPlan({
      description: $('parcela-descricao').value,
      totalAmountCents: reaisParaCentavos($('parcela-valor').value),
      installmentCount: Number($('parcela-qtd').value),
      purchaseDate: $('parcela-compra').value,
      firstDueDate: $('parcela-vencimento').value,
      category: $('parcela-categoria').value,
    });

    abertos.add(planId);
    $('parcela-descricao').value = '';
    $('parcela-valor').value = '';
    $('parcela-qtd').value = '';
    $('parcela-previa').textContent = '';
    definirDatasPadrao();
    mostrarToast('Compra cadastrada.');
    avisarMudanca();
  } catch (e) {
    mostrarErroForm(erro, e.message);
  } finally {
    botao.disabled = false;
  }
}

async function aoClicar(evento) {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const id = Number(botao.dataset.id);

  try {
    switch (botao.dataset.acao) {
      case 'pagar':
        await pagar(id);
        break;
      case 'desfazer-pagamento':
        await desfazerPagamento(id);
        break;
      case 'excluir-compra':
        await excluirCompra(id);
        break;
    }
  } catch (e) {
    tratarErro(e);
  }
}

async function pagar(id) {
  await markInstallmentPaid(id);
  avisarMudanca();
  mostrarToast('Parcela paga e lançada nos gastos de hoje.', {
    acaoRotulo: 'Desfazer',
    duracao: 7000,
    aoAcionar: async () => {
      await markInstallmentPending(id);
      avisarMudanca();
    },
  });
}

async function desfazerPagamento(id) {
  const ok = await confirmar({
    titulo: 'Desfazer pagamento?',
    mensagem: 'A parcela volta a ficar pendente e o gasto gerado por ela é removido.',
    rotuloConfirmar: 'Desfazer pagamento',
  });
  if (!ok) return;
  await markInstallmentPending(id);
  avisarMudanca();
  mostrarToast('Pagamento desfeito.');
}

async function excluirCompra(id) {
  const plano = planosAtuais.get(id);
  const pagas = plano?.paidCount ?? 0;
  const extra = pagas > 0 ? ` e ${pagas === 1 ? 'o gasto gerado' : `os ${pagas} gastos gerados`} pelos pagamentos já feitos` : '';
  const ok = await confirmar({
    titulo: 'Excluir compra?',
    mensagem: `Isto remove "${plano?.description ?? 'a compra'}", todas as suas parcelas${extra}. Não dá para desfazer.`,
    rotuloConfirmar: 'Excluir compra',
    perigo: true,
  });
  if (!ok) return;
  await deleteInstallmentPlan(id);
  abertos.delete(id);
  avisarMudanca();
  mostrarToast('Compra excluída.');
}

// ---------------------------------------------------------
// Desenho da tela
// ---------------------------------------------------------

function itemPendente(p, hoje) {
  const atrasada = p.status === 'overdue';
  const dias = diasEntre(p.dueDate, hoje);
  return el(
    'li',
    { class: 'item' },
    el(
      'div',
      { class: 'item__corpo' },
      el('p', { class: 'item__titulo', text: p.planDescription }),
      el(
        'div',
        { class: 'item__meta' },
        el('span', { text: `Parcela ${p.number}/${p.planInstallmentCount}` }),
        el('span', { text: `vence ${formatarData(p.dueDate)}` }),
        atrasada && el('span', { class: 'chip chip--alerta', text: dias === 1 ? '1 dia de atraso' : `${dias} dias de atraso` })
      )
    ),
    el(
      'div',
      { class: 'item__lado' },
      el('span', { class: 'item__valor', text: centavosParaReais(p.amountCents) }),
      el('button', { type: 'button', class: 'btn-mini btn-mini--primario', dataset: { acao: 'pagar', id: p.id }, text: 'Pagar' })
    )
  );
}

function itemDaCompra(p, hoje) {
  const situacao = classifyInstallment(p, hoje);
  const dias = diasEntre(p.dueDate, hoje);
  return el(
    'li',
    { class: 'item' },
    el(
      'div',
      { class: 'item__corpo' },
      el('p', { class: 'item__titulo', text: `Parcela ${p.number}` }),
      el(
        'div',
        { class: 'item__meta' },
        el('span', { text: `vence ${formatarData(p.dueDate)}` }),
        situacao === 'paid' && el('span', { class: 'chip chip--ok', text: `Paga em ${formatarData(p.paidAt)}` }),
        situacao === 'overdue' && el('span', { class: 'chip chip--alerta', text: dias === 1 ? '1 dia de atraso' : `${dias} dias de atraso` })
      )
    ),
    el(
      'div',
      { class: 'item__lado' },
      el('span', { class: 'item__valor', text: centavosParaReais(p.amountCents) }),
      situacao === 'paid'
        ? el('button', { type: 'button', class: 'btn-mini', dataset: { acao: 'desfazer-pagamento', id: p.id }, text: 'Desfazer' })
        : el('button', { type: 'button', class: 'btn-mini btn-mini--primario', dataset: { acao: 'pagar', id: p.id }, text: 'Pagar' })
    )
  );
}

function blocoCompra(plano, hoje) {
  const pct = Math.round((plano.paidCount * 100) / plano.installmentCount);
  const quitada = plano.paidCount === plano.installmentCount;

  return el(
    'details',
    { class: 'card compra', open: abertos.has(plano.id), dataset: { planId: plano.id } },
    el(
      'summary',
      {},
      el(
        'div',
        { class: 'compra__topo' },
        el('span', { class: 'compra__nome', text: plano.description }),
        el('span', { class: 'item__valor', text: centavosParaReais(plano.totalAmountCents) })
      ),
      el(
        'div',
        { class: 'item__meta' },
        el('span', { text: `${plano.paidCount}/${plano.installmentCount} pagas` }),
        quitada && el('span', { class: 'chip chip--ok', text: 'Quitada' }),
        el('span', { class: 'chip', text: plano.category })
      ),
      el('div', { class: 'progresso' }, el('div', { class: 'progresso__preenchimento', style: `width:${pct}%` }))
    ),
    el('ul', { class: 'lista' }, plano.installments.map((p) => itemDaCompra(p, hoje))),
    el(
      'div',
      { class: 'compra__conteudo compra__rodape' },
      el('button', { type: 'button', class: 'btn btn--perigo', dataset: { acao: 'excluir-compra', id: plano.id }, text: 'Excluir compra' })
    )
  );
}

export async function renderParcelas() {
  const minha = ++sequencia;
  const hoje = hojeISO();
  const [pendentes, planos] = await Promise.all([listPendingInstallments(hoje), listPlansWithInstallments()]);
  if (minha !== sequencia) return;

  planosAtuais = new Map(planos.map((p) => [p.id, p]));

  const atrasadas = pendentes.filter((p) => p.status === 'overdue');
  const proximas = pendentes.filter((p) => p.status === 'upcoming');
  const soma = (lista) => lista.reduce((total, p) => total + p.amountCents, 0);

  // Resumo do topo
  $('parcelas-total-pendente').textContent = centavosParaReais(soma(pendentes));
  const partes = [pendentes.length === 1 ? '1 parcela em aberto' : `${pendentes.length} parcelas em aberto`];
  if (atrasadas.length > 0) {
    partes.push(`${atrasadas.length} atrasada${atrasadas.length > 1 ? 's' : ''} (${centavosParaReais(soma(atrasadas))})`);
  }
  $('parcelas-nota').textContent = pendentes.length === 0 ? 'Nenhuma parcela em aberto' : partes.join(' · ');

  // Atrasadas
  $('bloco-atrasadas').hidden = atrasadas.length === 0;
  const listaAtrasadas = $('lista-atrasadas');
  limpar(listaAtrasadas);
  listaAtrasadas.append(...atrasadas.map((p) => itemPendente(p, hoje)));

  // Próximas
  const listaProximas = $('lista-proximas');
  limpar(listaProximas);
  if (proximas.length === 0) {
    listaProximas.append(el('li', { class: 'lista__vazio', text: 'Nenhuma parcela a vencer.' }));
  } else {
    listaProximas.append(...proximas.slice(0, MAX_PROXIMAS).map((p) => itemPendente(p, hoje)));
    if (proximas.length > MAX_PROXIMAS) {
      listaProximas.append(
        el('li', { class: 'lista__vazio', text: `+ ${proximas.length - MAX_PROXIMAS} parcelas depois destas (veja em "Compras parceladas").` })
      );
    }
  }

  // Compras
  const compras = $('lista-compras');
  limpar(compras);
  if (planos.length === 0) {
    compras.append(el('article', { class: 'card' }, el('p', { class: 'lista__vazio', text: 'Nenhuma compra parcelada cadastrada.' })));
  } else {
    compras.append(...planos.map((p) => blocoCompra(p, hoje)));
  }
}
