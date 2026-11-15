// ==========================================================
// views/gastos.js — tela Gastos
// Responsabilidade: formulário de despesa, histórico do mês com
// filtro por categoria, editar e excluir (com "Desfazer").
// Toda a regra de negócio está em expenses.js; aqui só há interface.
// ==========================================================

import {
  CATEGORIES,
  addExpense,
  updateExpense,
  deleteExpense,
  restoreExpense,
  getExpense,
  listExpensesByMonth,
  isLinkedExpense,
} from '../expenses.js';
import {
  reaisParaCentavos,
  centavosParaReais,
  centavosParaCampo,
  hojeISO,
  mesAtualISO,
  deslocarMes,
  nomeDoMes,
  formatarData,
  capitalizar,
} from '../utils.js';
import {
  el,
  limpar,
  preencherSelect,
  mostrarErroForm,
  limparErroForm,
  mostrarToast,
  tratarErro,
  avisarMudanca,
} from '../ui.js';

const $ = (id) => document.getElementById(id);

let mesVisto = mesAtualISO(); // mês exibido ("AAAA-MM")
let editandoId = null; // id da despesa em edição (null = cadastrando)
let sequencia = 0; // descarta respostas antigas se duas renderizações se cruzarem

/**
 * Cria a linha de uma despesa. Também é usada pelo Início
 * ("Últimos lançamentos"), por isso é exportada.
 */
export function criarItemDespesa(d, comAcoes = true) {
  const vinculada = isLinkedExpense(d);
  return el(
    'li',
    { class: 'item' },
    el(
      'div',
      { class: 'item__corpo' },
      el('p', { class: 'item__titulo', text: d.description }),
      el(
        'div',
        { class: 'item__meta' },
        el('span', { text: formatarData(d.date) }),
        el('span', { class: 'chip', text: d.category }),
        vinculada && el('span', { class: 'chip chip--info', text: 'Parcela' })
      )
    ),
    el(
      'div',
      { class: 'item__lado' },
      el('span', { class: 'item__valor', text: centavosParaReais(d.amountCents) }),
      comAcoes &&
        !vinculada &&
        el(
          'div',
          { class: 'item__acoes' },
          el('button', { type: 'button', class: 'btn-mini', dataset: { acao: 'editar', id: d.id }, text: 'Editar' }),
          el('button', { type: 'button', class: 'btn-mini btn-mini--perigo', dataset: { acao: 'excluir', id: d.id }, text: 'Excluir' })
        )
    )
  );
}

export function iniciarGastos() {
  preencherSelect($('gasto-categoria'), CATEGORIES.map((c) => ({ value: c, label: c })), CATEGORIES[0]);
  preencherSelect(
    $('gasto-filtro'),
    [{ value: '', label: 'Todas as categorias' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))],
    ''
  );
  $('gasto-data').value = hojeISO();

  $('gastos-mes-anterior').addEventListener('click', () => mudarMes(-1));
  $('gastos-mes-proximo').addEventListener('click', () => mudarMes(1));
  $('form-gasto').addEventListener('submit', salvar);
  $('gasto-cancelar').addEventListener('click', () => sairDaEdicao(true));
  $('gasto-filtro').addEventListener('change', () => renderGastos().catch(tratarErro));
  $('lista-gastos').addEventListener('click', aoClicarNaLista);
}

/** Cancela uma edição em andamento (usado depois de restaurar um backup). */
export function cancelarEdicaoGasto() {
  if (editandoId !== null) sairDaEdicao(true);
}

function mudarMes(delta) {
  mesVisto = deslocarMes(mesVisto, delta);
  renderGastos().catch(tratarErro);
}

async function salvar(evento) {
  evento.preventDefault();
  const botao = $('gasto-salvar');
  const erro = $('gasto-erro');
  if (botao.disabled) return; // evita toque duplo
  botao.disabled = true;
  limparErroForm(erro);

  try {
    const dados = {
      description: $('gasto-descricao').value,
      amountCents: reaisParaCentavos($('gasto-valor').value),
      category: $('gasto-categoria').value,
      date: $('gasto-data').value,
    };

    if (editandoId !== null) {
      await updateExpense(editandoId, dados);
      mostrarToast('Gasto atualizado.');
    } else {
      await addExpense(dados);
      mostrarToast('Gasto adicionado.');
    }

    // Mostra o mês do gasto salvo, senão ele "sumiria" da lista
    mesVisto = dados.date.slice(0, 7);
    sairDaEdicao(editandoId !== null);
    avisarMudanca();
  } catch (e) {
    mostrarErroForm(erro, e.message);
  } finally {
    botao.disabled = false;
  }
}

/** Volta o formulário ao modo "novo gasto". */
function sairDaEdicao(resetarCategoria) {
  editandoId = null;
  $('gasto-descricao').value = '';
  $('gasto-valor').value = '';
  $('gasto-data').value = hojeISO();
  if (resetarCategoria) $('gasto-categoria').value = CATEGORIES[0];
  $('gasto-form-titulo').textContent = 'Novo gasto';
  $('gasto-salvar').textContent = 'Adicionar gasto';
  $('gasto-cancelar').hidden = true;
  limparErroForm($('gasto-erro'));
}

async function iniciarEdicao(id) {
  const d = await getExpense(id);
  if (!d) throw new Error('Despesa não encontrada.');

  editandoId = id;
  $('gasto-descricao').value = d.description;
  $('gasto-valor').value = centavosParaCampo(d.amountCents);
  $('gasto-data').value = d.date;
  $('gasto-categoria').value = d.category;
  $('gasto-form-titulo').textContent = 'Editar gasto';
  $('gasto-salvar').textContent = 'Salvar alterações';
  $('gasto-cancelar').hidden = false;
  limparErroForm($('gasto-erro'));

  $('form-gasto').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('gasto-descricao').focus();
}

async function excluir(id) {
  const removido = await deleteExpense(id);
  if (editandoId === id) sairDaEdicao(true);
  avisarMudanca();
  mostrarToast('Gasto excluído.', {
    acaoRotulo: 'Desfazer',
    duracao: 7000,
    aoAcionar: async () => {
      await restoreExpense(removido);
      avisarMudanca();
    },
  });
}

async function aoClicarNaLista(evento) {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const id = Number(botao.dataset.id);
  try {
    if (botao.dataset.acao === 'editar') await iniciarEdicao(id);
    if (botao.dataset.acao === 'excluir') await excluir(id);
  } catch (e) {
    tratarErro(e);
  }
}

export async function renderGastos() {
  const minha = ++sequencia;
  const despesas = await listExpensesByMonth(mesVisto);
  if (minha !== sequencia) return; // chegou uma renderização mais nova

  const filtro = $('gasto-filtro').value;
  const visiveis = filtro ? despesas.filter((d) => d.category === filtro) : despesas;
  const total = despesas.reduce((soma, d) => soma + d.amountCents, 0);

  $('gastos-mes-rotulo').textContent = capitalizar(nomeDoMes(mesVisto));
  $('gastos-total').textContent = centavosParaReais(total);

  let nota = despesas.length === 0 ? 'Nenhuma despesa neste mês' : despesas.length === 1 ? '1 despesa' : `${despesas.length} despesas`;
  if (filtro && despesas.length > 0) nota += ` · mostrando ${visiveis.length} em ${filtro}`;
  $('gastos-nota').textContent = nota;

  const lista = $('lista-gastos');
  limpar(lista);
  if (visiveis.length === 0) {
    lista.append(
      el('li', { class: 'lista__vazio', text: filtro && despesas.length > 0 ? 'Nenhum gasto nesta categoria.' : 'Nenhum gasto registrado neste mês.' })
    );
  } else {
    lista.append(...visiveis.map((d) => criarItemDespesa(d, true)));
  }
}
