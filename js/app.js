// ==========================================================
// app.js — inicialização do Meu Organizador
// Responsabilidade: "ligar" tudo. Aqui NÃO ficam regras de negócio
// (isso está em expenses.js, installments.js, calendar.js...) nem
// desenho de telas (isso está em js/views/).
//
// Ordem de inicialização:
//   1. registra o Service Worker (funcionamento offline)
//   2. liga navegação e formulários das telas
//   3. espera o desbloqueio, se houver PIN
//   4. desenha todas as telas com os dados do banco
//   5. liga o vigia de lembretes da agenda
// ==========================================================

import { iniciarNavegacao } from './nav.js';
import { iniciarSeguranca } from './security.js';
import { aoMudarDados, tratarErro } from './ui.js';
import { startReminderWatcher } from './calendar.js';
import { capitalizar, hojeISO, formatarDataLonga } from './utils.js';
import { iniciarGastos, renderGastos } from './views/gastos.js';
import { iniciarParcelas, renderParcelas } from './views/parcelas.js';
import { iniciarAgenda, renderAgenda } from './views/agenda.js';
import { iniciarAjustes, renderAjustes } from './views/ajustes.js';
import { renderDashboard, renderAvisos } from './views/dashboard.js';

/** Registra o Service Worker. Falhar aqui não impede o app de funcionar. */
async function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('service-worker.js');
  } catch (erro) {
    // Acontece em endereços sem HTTPS (fora de localhost). O app abre, só não fica offline.
    console.warn('Service Worker não registrado:', erro);
  }
}

/** Mostra a data de hoje no cabeçalho. */
function atualizarCabecalho() {
  document.getElementById('data-hoje').textContent = capitalizar(formatarDataLonga(hojeISO()));
}

/**
 * Redesenha todas as telas. Se uma falhar, as outras continuam e
 * o usuário vê um único aviso (não um por tela).
 */
async function renderTudo() {
  const resultados = await Promise.allSettled([
    renderDashboard(),
    renderGastos(),
    renderParcelas(),
    renderAgenda(),
    renderAjustes(),
  ]);
  const falha = resultados.find((r) => r.status === 'rejected');
  if (falha) tratarErro(falha.reason);
}

async function iniciar() {
  registrarServiceWorker(); // sem await: não precisa atrasar o resto
  atualizarCabecalho();

  iniciarNavegacao();
  iniciarGastos();
  iniciarParcelas();
  iniciarAgenda();
  iniciarAjustes();

  // Toda tela que grava algo chama avisarMudanca(); aqui redesenhamos tudo.
  aoMudarDados(() => renderTudo());

  // Voltar ao app (ex.: virou o dia) atualiza data e telas
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      atualizarCabecalho();
      renderTudo();
    }
  });

  await iniciarSeguranca(); // só segue depois do PIN correto (ou na hora, sem PIN)
  await renderTudo();

  // Verifica lembretes agora e a cada 30 s. A cada verificação atualiza só os
  // avisos e a Agenda (que não redesenham se nada mudou). Se o DIA virou com
  // o app aberto, redesenha tudo (parcelas que venceram, data do cabeçalho).
  let diaDesenhado = hojeISO();
  startReminderWatcher(async () => {
    if (hojeISO() !== diaDesenhado) {
      diaDesenhado = hojeISO();
      atualizarCabecalho();
      await renderTudo();
    } else {
      await Promise.all([renderAvisos(), renderAgenda()]);
    }
  });
}

// Outra aba antiga do app está segurando o banco e impede a atualização dele
document.addEventListener('banco-bloqueado', () =>
  tratarErro(new Error('Feche as outras abas ou janelas do Meu Organizador e abra o app de novo.'))
);

iniciar().catch(tratarErro);
