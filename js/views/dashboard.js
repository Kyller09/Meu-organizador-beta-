// ==========================================================
// views/dashboard.js — tela Início
// Responsabilidade: juntar os dados de todos os módulos num resumo:
// gastos do mês (com comparação), parcelas pendentes, próximos
// compromissos, gráficos, últimos lançamentos e avisos.
// ==========================================================

import { getMonthSummary, getCategoryTotals, getMonthlyTotals, listRecentExpenses } from '../expenses.js';
import { getInstallmentsSummary } from '../installments.js';
import { listUpcomingEvents, getActiveReminders } from '../calendar.js';
import { backupIsDue } from '../backup.js';
import {
  centavosParaReais,
  formatarCompacto,
  formatarDataCurta,
  mesAtualISO,
  nomeMesLongo,
  nomeMesCurto,
} from '../utils.js';
import { el, limpar, tratarErro } from '../ui.js';
import { irParaTela } from '../nav.js';
import { criarItemDespesa } from './gastos.js';

const $ = (id) => document.getElementById(id);

let sequencia = 0;
let sequenciaAvisos = 0;
let ultimaAssinaturaAvisos = null; // evita redesenhar os banners sem mudança
const dispensados = new Set(); // lembretes que o usuário fechou nesta sessão

function textoComparacao(atual, anterior, nomeMesAnterior) {
  if (anterior === 0) return { texto: '', classe: '' };
  if (atual === anterior) return { texto: `Igual a ${nomeMesAnterior}`, classe: '' };

  const diferenca = atual - anterior;
  const pct = Math.max(1, Math.round((Math.abs(diferenca) * 100) / anterior));
  const valor = centavosParaReais(anterior);
  return diferenca > 0
    ? { texto: `▲ ${pct}% a mais que em ${nomeMesAnterior} (${valor})`, classe: 'card__comparacao--sobe' }
    : { texto: `▼ ${pct}% a menos que em ${nomeMesAnterior} (${valor})`, classe: 'card__comparacao--desce' };
}

function graficoCategorias(categorias) {
  const alvo = $('grafico-categorias');
  limpar(alvo);
  if (categorias.length === 0) {
    alvo.append(el('p', { class: 'lista__vazio', text: 'Sem gastos neste mês.' }));
    return;
  }
  const maior = categorias[0].totalCents;
  for (const c of categorias) {
    const largura = Math.max(2, Math.round((c.totalCents * 100) / maior));
    alvo.append(
      el(
        'div',
        { class: 'barra-linha' },
        el('span', { class: 'barra-linha__rotulo', text: c.category }),
        el('div', { class: 'barra' }, el('div', { class: 'barra__preenchimento', style: `width:${largura}%` })),
        el('span', { class: 'barra-linha__valor', text: centavosParaReais(c.totalCents) })
      )
    );
  }
}

function graficoMeses(mensais) {
  const alvo = $('grafico-meses');
  limpar(alvo);
  const maior = Math.max(...mensais.map((m) => m.totalCents));
  if (maior === 0) {
    alvo.append(el('p', { class: 'lista__vazio', text: 'Sem gastos nos últimos 6 meses.' }));
    return;
  }
  const colunas = el('div', { class: 'colunas' });
  mensais.forEach((m, i) => {
    // 70% da altura da coluna fica para a barra; o resto, para os textos
    const altura = (m.totalCents * 70) / maior;
    colunas.append(
      el(
        'div',
        { class: i === mensais.length - 1 ? 'coluna coluna--atual' : 'coluna', title: `${nomeMesLongo(m.anoMes)}: ${centavosParaReais(m.totalCents)}` },
        el('span', { class: 'coluna__valor', text: m.totalCents > 0 ? formatarCompacto(m.totalCents) : '' }),
        el('div', { class: 'coluna__barra', style: `height:${altura}%` }),
        el('span', { class: 'coluna__rotulo', text: nomeMesCurto(m.anoMes) })
      )
    );
  });
  alvo.append(colunas);
}

export async function renderDashboard() {
  const minha = ++sequencia;
  const mes = mesAtualISO();

  const [resumo, categorias, mensais, recentes, parcelas, proximos] = await Promise.all([
    getMonthSummary(mes),
    getCategoryTotals(mes),
    getMonthlyTotals(mes, 6),
    listRecentExpenses(5),
    getInstallmentsSummary(),
    listUpcomingEvents({ dias: 7 }),
  ]);
  if (minha !== sequencia) return;

  // ----- cartão principal -----
  $('mes-atual').textContent = nomeMesLongo(mes);
  $('total-gastos-mes').textContent = centavosParaReais(resumo.totalCents);
  $('nota-gastos-mes').textContent =
    resumo.count === 0 ? 'Nenhuma despesa registrada ainda' : resumo.count === 1 ? '1 despesa neste mês' : `${resumo.count} despesas neste mês`;

  const mesAnterior = mensais[mensais.length - 2];
  const comparacao = textoComparacao(resumo.totalCents, mesAnterior.totalCents, nomeMesLongo(mesAnterior.anoMes));
  const campoComparacao = $('comparacao-mes');
  campoComparacao.textContent = comparacao.texto;
  campoComparacao.className = `card__comparacao ${comparacao.classe}`.trim();

  // ----- parcelas -----
  $('qtd-prestacoes').textContent = String(parcelas.pendingCount);
  if (parcelas.overdueCount > 0) {
    $('nota-prestacoes').textContent =
      parcelas.overdueCount === 1
        ? `1 atrasada (${centavosParaReais(parcelas.overdueTotalCents)})`
        : `${parcelas.overdueCount} atrasadas (${centavosParaReais(parcelas.overdueTotalCents)})`;
  } else if (parcelas.nextDue) {
    $('nota-prestacoes').textContent = `Próxima: ${formatarDataCurta(parcelas.nextDue.dueDate)} · ${centavosParaReais(parcelas.nextDue.amountCents)}`;
  } else {
    $('nota-prestacoes').textContent = 'Nenhuma parcela em aberto';
  }

  // ----- compromissos -----
  $('qtd-compromissos').textContent = String(proximos.length);
  $('nota-compromissos').textContent = proximos[0]
    ? `Próximo: ${proximos[0].title} · ${formatarDataCurta(proximos[0].date)} ${proximos[0].time}`
    : 'Nada nos próximos 7 dias';

  // ----- gráficos e lista -----
  graficoCategorias(categorias);
  graficoMeses(mensais);

  const lista = $('lista-recentes');
  limpar(lista);
  if (recentes.length === 0) {
    lista.append(el('li', { class: 'lista__vazio', text: 'Seus lançamentos recentes vão aparecer aqui.' }));
  } else {
    lista.append(...recentes.map((d) => criarItemDespesa(d, false)));
  }

  await renderAvisos();
}

/** Banners do topo do Início: lembretes ativos e lembrete de backup. */
export async function renderAvisos() {
  const minha = ++sequenciaAvisos;
  const [lembretes, backupPendente] = await Promise.all([getActiveReminders(), backupIsDue()]);
  if (minha !== sequenciaAvisos) return;

  const chaveDe = (e) => `${e.id}|${e.date}|${e.time}|${e.reminder}|${e.title}`;
  const visiveis = lembretes.filter((e) => !dispensados.has(chaveDe(e)));

  // Sem mudança em relação ao que já está na tela? Não mexe (o vigia chama a cada 30 s).
  const assinatura = JSON.stringify([visiveis.map(chaveDe), backupPendente]);
  if (assinatura === ultimaAssinaturaAvisos) return;
  ultimaAssinaturaAvisos = assinatura;

  const area = $('lembretes-area');
  limpar(area);

  for (const e of visiveis) {
    const chave = chaveDe(e);
    area.append(
      el(
        'div',
        { class: 'aviso aviso--lembrete', role: 'status' },
        el('div', {}, el('strong', { text: `🔔 ${e.title}` }), el('small', { text: `${formatarDataCurta(e.date)} às ${e.time}` })),
        el('button', {
          type: 'button',
          class: 'btn-mini',
          text: 'OK',
          onclick: () => {
            dispensados.add(chave);
            renderAvisos().catch(tratarErro);
          },
        })
      )
    );
  }

  if (backupPendente) {
    area.append(
      el(
        'div',
        { class: 'aviso aviso--info' },
        el('div', {}, el('strong', { text: 'Faça um backup dos seus dados' }), el('small', { text: 'Eles ficam só neste aparelho.' })),
        el('button', { type: 'button', class: 'btn-mini', text: 'Ajustes', onclick: () => irParaTela('ajustes') })
      )
    );
  }
}
