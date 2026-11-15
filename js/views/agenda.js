// ==========================================================
// views/agenda.js — tela Agenda
// Responsabilidade: formulário de compromisso, lista de próximos
// (agrupados por dia) e passados, editar/excluir (com "Desfazer")
// e o botão de ativar notificações. Regras em calendar.js.
// ==========================================================

import {
  REMINDER_OPTIONS,
  reminderLabel,
  addEvent,
  updateEvent,
  deleteEvent,
  restoreEvent,
  getEvent,
  listUpcomingEvents,
  listPastEvents,
  getNotificationStatus,
  requestNotificationPermission,
  dispatchDueNotifications,
} from '../calendar.js';
import { hojeISO, formatarDataLonga, formatarData, capitalizar } from '../utils.js';
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

const HORA_PADRAO = '09:00';
const MAX_PASSADOS = 20;

let editandoId = null;
let sequencia = 0;
let ultimaAssinatura = ''; // resumo dos dados já desenhados (evita redesenhar à toa)

export function iniciarAgenda() {
  preencherSelect(
    $('evento-lembrete'),
    REMINDER_OPTIONS.map((o) => ({ value: o.value === null ? '' : String(o.value), label: o.label })),
    ''
  );
  limparFormulario();

  $('form-evento').addEventListener('submit', salvar);
  $('evento-cancelar').addEventListener('click', limparFormulario);
  $('tela-agenda').addEventListener('click', aoClicarNaLista);
  $('btn-notificacoes').addEventListener('click', async () => {
    try {
      await requestNotificationPermission();
      renderNotificacoes();
      await dispatchDueNotifications();
    } catch (e) {
      tratarErro(e);
    }
  });
}

/** Cancela uma edição em andamento (usado depois de restaurar um backup). */
export function cancelarEdicaoEvento() {
  if (editandoId !== null) limparFormulario();
}

function limparFormulario() {
  editandoId = null;
  $('evento-titulo').value = '';
  $('evento-descricao').value = '';
  $('evento-data').value = hojeISO();
  $('evento-hora').value = HORA_PADRAO;
  $('evento-lembrete').value = '';
  $('evento-form-titulo').textContent = 'Novo compromisso';
  $('evento-salvar').textContent = 'Adicionar compromisso';
  $('evento-cancelar').hidden = true;
  limparErroForm($('evento-erro'));
}

async function salvar(evento) {
  evento.preventDefault();
  const botao = $('evento-salvar');
  const erro = $('evento-erro');
  if (botao.disabled) return;
  botao.disabled = true;
  limparErroForm(erro);

  try {
    const lembrete = $('evento-lembrete').value;
    const dados = {
      title: $('evento-titulo').value,
      description: $('evento-descricao').value,
      date: $('evento-data').value,
      time: $('evento-hora').value,
      reminder: lembrete === '' ? null : Number(lembrete),
    };

    if (editandoId !== null) {
      await updateEvent(editandoId, dados);
      mostrarToast('Compromisso atualizado.');
    } else {
      await addEvent(dados);
      mostrarToast('Compromisso adicionado.');
    }
    limparFormulario();
    avisarMudanca();
  } catch (e) {
    mostrarErroForm(erro, e.message);
  } finally {
    botao.disabled = false;
  }
}

async function iniciarEdicao(id) {
  const e = await getEvent(id);
  if (!e) throw new Error('Compromisso não encontrado.');

  editandoId = id;
  $('evento-titulo').value = e.title;
  $('evento-descricao').value = e.description;
  $('evento-data').value = e.date;
  $('evento-hora').value = e.time;
  $('evento-lembrete').value = e.reminder === null ? '' : String(e.reminder);
  $('evento-form-titulo').textContent = 'Editar compromisso';
  $('evento-salvar').textContent = 'Salvar alterações';
  $('evento-cancelar').hidden = false;
  limparErroForm($('evento-erro'));

  $('form-evento').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('evento-titulo').focus();
}

async function excluir(id) {
  const removido = await deleteEvent(id);
  if (editandoId === id) limparFormulario();
  avisarMudanca();
  mostrarToast('Compromisso excluído.', {
    acaoRotulo: 'Desfazer',
    duracao: 7000,
    aoAcionar: async () => {
      await restoreEvent(removido);
      avisarMudanca();
    },
  });
}

async function aoClicarNaLista(evento) {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const id = Number(botao.dataset.id);
  try {
    if (botao.dataset.acao === 'editar-evento') await iniciarEdicao(id);
    if (botao.dataset.acao === 'excluir-evento') await excluir(id);
  } catch (e) {
    tratarErro(e);
  }
}

function itemEvento(e) {
  return el(
    'li',
    { class: 'item' },
    el(
      'div',
      { class: 'item__corpo' },
      el('p', { class: 'item__titulo', text: e.title }),
      el(
        'div',
        { class: 'item__meta' },
        el('span', { class: 'evento-hora', text: e.time }),
        e.reminder !== null && el('span', { class: 'chip', text: `🔔 ${reminderLabel(e.reminder)}` })
      ),
      e.description && el('p', { class: 'item__texto', text: e.description })
    ),
    el(
      'div',
      { class: 'item__lado' },
      el(
        'div',
        { class: 'item__acoes' },
        el('button', { type: 'button', class: 'btn-mini', dataset: { acao: 'editar-evento', id: e.id }, text: 'Editar' }),
        el('button', { type: 'button', class: 'btn-mini btn-mini--perigo', dataset: { acao: 'excluir-evento', id: e.id }, text: 'Excluir' })
      )
    )
  );
}

/** Mostra se as notificações do sistema estão ativas e o botão para ativar. */
export function renderNotificacoes() {
  const estado = getNotificationStatus();
  const base =
    'Os lembretes aparecem enquanto o app está aberto: o Android não permite alarmes exatos com o app fechado. ';
  const textos = {
    unsupported: 'Este navegador não oferece notificações do sistema.',
    default: 'Ative as notificações para receber também o aviso do sistema.',
    granted: 'Notificações do sistema ativadas.',
    denied: 'Notificações bloqueadas nas configurações do navegador.',
  };
  $('texto-notificacoes').textContent = base + (textos[estado] ?? '');
  $('btn-notificacoes').hidden = estado !== 'default';
}

export async function renderAgenda() {
  const minha = ++sequencia;
  const agora = Date.now();
  const [proximos, passados] = await Promise.all([
    listUpcomingEvents({ agora }),
    listPastEvents({ agora, limite: MAX_PASSADOS }),
  ]);
  if (minha !== sequencia) return;

  renderNotificacoes();

  // O vigia chama esta função a cada 30 s. Se nada mudou, não mexemos na
  // tela: trocar os botões bem na hora de um toque faria o toque se perder.
  const assinatura = JSON.stringify([proximos, passados]);
  if (assinatura === ultimaAssinatura) return;
  ultimaAssinatura = assinatura;

  // Próximos, agrupados por dia (a lista já vem em ordem cronológica)
  const area = $('lista-proximos');
  limpar(area);
  if (proximos.length === 0) {
    area.append(el('article', { class: 'card' }, el('p', { class: 'lista__vazio', text: 'Nenhum compromisso futuro.' })));
  } else {
    const cartao = el('article', { class: 'card' });
    let dataAtual = null;
    let listaAtual = null;
    for (const e of proximos) {
      if (e.date !== dataAtual) {
        dataAtual = e.date;
        cartao.append(el('p', { class: 'grupo-data', text: capitalizar(formatarDataLonga(e.date)) }));
        listaAtual = el('ul', { class: 'lista' });
        cartao.append(listaAtual);
      }
      listaAtual.append(itemEvento(e));
    }
    area.append(cartao);
  }

  // Passados (dentro de um bloco recolhido)
  $('resumo-passados').textContent = passados.length === 0 ? 'Passados' : `Passados (${passados.length})`;
  const listaPassados = $('lista-passados');
  limpar(listaPassados);
  if (passados.length === 0) {
    listaPassados.append(el('li', { class: 'lista__vazio', text: 'Nenhum compromisso passado.' }));
  } else {
    for (const e of passados) {
      const item = itemEvento(e);
      item.querySelector('.item__meta')?.prepend(el('span', { text: formatarData(e.date) }));
      listaPassados.append(item);
    }
  }
}
