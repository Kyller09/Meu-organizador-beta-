// ==========================================================
// calendar.js — agenda de compromissos e lembretes
// Responsabilidade: cadastrar compromissos, listar os próximos e
// cuidar dos lembretes locais.
//
// Campos de um compromisso (Event):
//   id, title, description, date ("AAAA-MM-DD"), time ("HH:MM"),
//   reminder (null = sem lembrete, ou minutos antes: 0, 10, 30, 60...),
//   notified (true depois que a notificação do sistema foi enviada),
//   createdAt
//
// LIMITAÇÕES DOS LEMBRETES EM UM PWA (importante ser honesto):
//   - Com o app FECHADO, o Android não nos deixa agendar um alarme
//     exato. Não existe API estável para isso na web.
//   - O que fazemos: enquanto o app está aberto (ou voltou ao primeiro
//     plano), verificamos a cada 30 s se algum lembrete venceu. Se sim,
//     mostramos um aviso dentro do app e, havendo permissão, uma
//     notificação do sistema.
//   - Um lembrete vale por uma "janela": do horário do aviso até 1 hora
//     depois do compromisso. Passou disso, é considerado perdido (não
//     queremos disparar avisos velhos de uma vez ao abrir o app).
//   - Não use este app como único despertador para algo crítico.
// ==========================================================

import {
  STORES,
  addRecord,
  getRecord,
  getAllRecords,
  updateRecord,
  deleteRecord,
} from './database.js';
import { isValidISODate, parseISO } from './utils.js';

/** Opções de lembrete mostradas na tela. */
export const REMINDER_OPTIONS = [
  { value: null, label: 'Sem lembrete' },
  { value: 0, label: 'No horário' },
  { value: 10, label: '10 minutos antes' },
  { value: 30, label: '30 minutos antes' },
  { value: 60, label: '1 hora antes' },
  { value: 1440, label: '1 dia antes' },
];

/** Texto do lembrete: reminderLabel(10) -> "10 minutos antes". */
export function reminderLabel(valor) {
  const achada = REMINDER_OPTIONS.find((o) => o.value === valor);
  return achada ? achada.label : `${valor} min antes`;
}

/** Quanto tempo depois do compromisso o lembrete ainda é mostrado. */
export const REMINDER_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------
// Validação e horários (funções puras)
// ---------------------------------------------------------

/** Confere os campos de um compromisso e devolve uma versão limpa. */
export function validateEventFields({ title, description, date, time, reminder }) {
  const titulo = String(title ?? '').trim();
  if (!titulo) throw new Error('Informe um título.');

  if (!isValidISODate(date)) throw new Error('Informe uma data válida.');

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) {
    throw new Error('Informe um horário válido.');
  }

  const lembrete = reminder ?? null;
  if (lembrete !== null && (!Number.isInteger(lembrete) || lembrete < 0 || lembrete > 10080)) {
    throw new Error('Lembrete inválido.');
  }

  return {
    title: titulo,
    description: String(description ?? '').trim(),
    date,
    time,
    reminder: lembrete,
  };
}

/** Momento do compromisso em milissegundos, no fuso LOCAL do aparelho. */
export function eventTimestamp(evento) {
  const { ano, mes, dia } = parseISO(evento.date);
  const [hora, minuto] = evento.time.split(':').map(Number);
  return new Date(ano, mes - 1, dia, hora, minuto).getTime();
}

/** Momento em que o lembrete deve aparecer (ou null se não há lembrete). */
export function reminderTime(evento) {
  if (evento.reminder === null || evento.reminder === undefined) return null;
  return eventTimestamp(evento) - evento.reminder * 60 * 1000;
}

// ---------------------------------------------------------
// Operações no banco
// ---------------------------------------------------------

/** Cadastra um compromisso. Devolve o id. */
export async function addEvent({ title, description = '', date, time, reminder = null }) {
  const limpo = validateEventFields({ title, description, date, time, reminder });
  // Se o compromisso já começou ao ser criado, não faz sentido avisar na hora.
  const registro = {
    ...limpo,
    notified: eventTimestamp(limpo) <= Date.now(),
    createdAt: new Date().toISOString(),
  };
  return addRecord(STORES.EVENTS, registro);
}

/** Busca um compromisso pelo id. */
export function getEvent(id) {
  return getRecord(STORES.EVENTS, id);
}

/**
 * Edita um compromisso. Se mudar data, hora ou lembrete, o aviso volta
 * a valer (notified = false), porque é como se fosse um compromisso novo.
 */
export async function updateEvent(id, mudancas) {
  const atual = await getRecord(STORES.EVENTS, id);
  if (!atual) throw new Error('Compromisso não encontrado.');

  const novos = validateEventFields({ ...atual, ...mudancas });
  const mudouHorario =
    novos.date !== atual.date || novos.time !== atual.time || novos.reminder !== atual.reminder;

  // Mudou o horário: o aviso volta a valer (a menos que o compromisso já tenha começado).
  const notified = mudouHorario ? eventTimestamp(novos) <= Date.now() : atual.notified;
  const atualizado = { ...atual, ...novos, notified };
  await updateRecord(STORES.EVENTS, atualizado);
  return atualizado;
}

/** Exclui e devolve o registro excluído (a tela oferece "Desfazer"). */
export async function deleteEvent(id) {
  const atual = await getRecord(STORES.EVENTS, id);
  if (!atual) throw new Error('Compromisso não encontrado.');
  await deleteRecord(STORES.EVENTS, id);
  return atual;
}

/** Recoloca um compromisso excluído (mesmo id). Usado pelo "Desfazer". */
export function restoreEvent(registro) {
  return updateRecord(STORES.EVENTS, registro);
}

/** Todos os compromissos, do mais cedo para o mais tarde. */
export async function listEvents() {
  const todos = await getAllRecords(STORES.EVENTS);
  return todos.sort((a, b) => eventTimestamp(a) - eventTimestamp(b) || a.id - b.id);
}

/**
 * Compromissos que ainda vão acontecer (horário >= agora).
 * `dias` limita à janela dos próximos N dias; `limite` limita a quantidade.
 */
export async function listUpcomingEvents({ agora = Date.now(), dias = null, limite = null } = {}) {
  const fim = dias === null ? Infinity : agora + dias * 24 * 60 * 60 * 1000;
  const lista = (await listEvents()).filter((e) => {
    const ts = eventTimestamp(e);
    return ts >= agora && ts <= fim;
  });
  return limite === null ? lista : lista.slice(0, limite);
}

/** Compromissos que já passaram, o mais recente primeiro. */
export async function listPastEvents({ agora = Date.now(), limite = null } = {}) {
  const lista = (await listEvents()).filter((e) => eventTimestamp(e) < agora).reverse();
  return limite === null ? lista : lista.slice(0, limite);
}

/**
 * Lembretes "ativos" agora: já passou o horário do aviso e o compromisso
 * ainda não está velho demais (veja REMINDER_WINDOW_MS). O Início
 * mostra esses avisos num banner.
 */
export async function getActiveReminders(agora = Date.now()) {
  return (await listEvents()).filter((e) => {
    const aviso = reminderTime(e);
    return aviso !== null && aviso <= agora && agora <= eventTimestamp(e) + REMINDER_WINDOW_MS;
  });
}

// ---------------------------------------------------------
// Notificações do sistema
// ---------------------------------------------------------

/** 'unsupported' | 'default' (ainda não perguntou) | 'granted' | 'denied' */
export function getNotificationStatus() {
  return 'Notification' in globalThis ? Notification.permission : 'unsupported';
}

/** Pede permissão ao usuário (só funciona a partir de um toque/clique). */
export async function requestNotificationPermission() {
  if (getNotificationStatus() === 'unsupported') return 'unsupported';
  return Notification.requestPermission();
}

/**
 * Mostra UMA notificação do sistema. No Android, o Chrome NÃO deixa
 * usar `new Notification()` (dá "Illegal constructor"): precisa passar
 * pelo Service Worker (`registration.showNotification`). Por isso
 * tentamos o Service Worker primeiro.
 */
async function showSystemNotification(evento) {
  const corpo = evento.description ? `${evento.time} — ${evento.description}` : evento.time;
  const opcoes = {
    body: corpo,
    icon: new URL('assets/icons/icon-192.png', document.baseURI).href,
    tag: `evento-${evento.id}`, // a mesma tag nunca gera duas notificações iguais
  };

  try {
    if ('serviceWorker' in navigator) {
      // .ready nunca termina se o Service Worker não foi registrado;
      // por isso esperamos no máximo 2 segundos.
      const registro = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      if (registro) {
        await registro.showNotification(evento.title, opcoes);
        return true;
      }
    }
    new Notification(evento.title, opcoes);
    return true;
  } catch (erro) {
    console.error('Não foi possível mostrar a notificação:', erro);
    return false;
  }
}

/**
 * Envia a notificação do sistema dos lembretes ativos que ainda não
 * foram notificados (uma vez só por compromisso). Sem permissão, não
 * faz nada e NÃO marca como notificado — se o usuário liberar depois,
 * ainda dentro da janela, o aviso sai. Devolve quantas enviou.
 */
let despachando = false; // trava: só um envio por vez (evita notificação em dobro)

export async function dispatchDueNotifications(agora = Date.now()) {
  if (getNotificationStatus() !== 'granted') return 0;
  if (despachando) return 0;
  despachando = true;

  try {
    let enviadas = 0;
    for (const evento of await getActiveReminders(agora)) {
      if (evento.notified) continue;
      if (await showSystemNotification(evento)) {
        // Relemos o registro: enquanto esperávamos, o usuário pode ter
        // editado ou EXCLUÍDO o compromisso. Gravar a cópia antiga
        // desfaria a edição ou ressuscitaria o compromisso excluído.
        const atual = await getRecord(STORES.EVENTS, evento.id);
        const igual =
          atual && atual.date === evento.date && atual.time === evento.time && atual.reminder === evento.reminder;
        if (igual) await updateRecord(STORES.EVENTS, { ...atual, notified: true });
        enviadas += 1;
      }
    }
    return enviadas;
  } finally {
    despachando = false;
  }
}

// ---------------------------------------------------------
// Vigia de lembretes
// ---------------------------------------------------------

let temporizador = null;
let ouvindoVisibilidade = false;
let verificarAtual = null; // a verificação mais recente (usada pelo ouvinte de visibilidade)

/**
 * Liga o "vigia": verifica agora, a cada 30 s e sempre que o app volta
 * ao primeiro plano. `aoVerificar` é chamada depois de cada verificação
 * (a tela usa para atualizar o banner de lembretes).
 */
export function startReminderWatcher(aoVerificar, intervaloMs = 30000) {
  const verificar = async () => {
    try {
      await dispatchDueNotifications();
    } catch (erro) {
      console.error('Falha ao verificar lembretes:', erro);
    }
    try {
      await aoVerificar?.();
    } catch (erro) {
      console.error('Falha ao atualizar lembretes na tela:', erro);
    }
  };

  verificarAtual = verificar;
  clearInterval(temporizador);
  temporizador = setInterval(verificar, intervaloMs);

  // O ouvinte é registrado uma única vez, mesmo que o vigia seja religado.
  if (!ouvindoVisibilidade) {
    ouvindoVisibilidade = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') verificarAtual?.();
    });
  }

  return verificar();
}
