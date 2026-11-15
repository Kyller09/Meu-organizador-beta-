// ==========================================================
// views/ajustes.js — tela Ajustes
// Responsabilidade: backup (exportar/restaurar), proteção do
// armazenamento e bloqueio por PIN. Regras em backup.js e security.js.
// ==========================================================

import {
  downloadBackup,
  parseBackup,
  restoreBackup,
  getLastBackupAt,
  MAX_BACKUP_BYTES,
} from '../backup.js';
import {
  pinEnabled,
  pinSupported,
  setPin,
  removePin,
  validatePinFormat,
  bloquear,
} from '../security.js';
import { formatarData, montarISO } from '../utils.js';
import { cancelarEdicaoGasto } from './gastos.js';
import { cancelarEdicaoEvento } from './agenda.js';
import {
  mostrarErroForm,
  limparErroForm,
  mostrarToast,
  confirmar,
  tratarErro,
  avisarMudanca,
} from '../ui.js';

const $ = (id) => document.getElementById(id);

export function iniciarAjustes() {
  // ----- backup -----
  $('btn-exportar').addEventListener('click', exportar);
  $('btn-importar').addEventListener('click', () => $('arquivo-importar').click());
  $('arquivo-importar').addEventListener('change', aoEscolherArquivo);

  // ----- armazenamento -----
  $('btn-persistir').addEventListener('click', pedirPersistencia);

  // ----- PIN -----
  $('form-pin').addEventListener('submit', salvarPin);
  $('pin-remover').addEventListener('click', removerPin);
  $('btn-bloquear-agora').addEventListener('click', () => {
    bloquear();
  });
}

export async function renderAjustes() {
  renderInfoBackup();
  renderPin();
  await renderArmazenamento();
}

// ---------------------------------------------------------
// Backup
// ---------------------------------------------------------

function dataLocalISO(data) {
  return montarISO(data.getFullYear(), data.getMonth() + 1, data.getDate());
}

function renderInfoBackup() {
  const ultimo = getLastBackupAt();
  $('info-backup').textContent = ultimo
    ? `Último backup gerado neste aparelho: ${formatarData(dataLocalISO(new Date(ultimo)))}. Confira se o arquivo foi salvo (pasta Downloads) e guarde uma cópia fora do celular.`
    : 'Você ainda não fez nenhum backup neste aparelho.';
}

async function exportar() {
  try {
    const nome = await downloadBackup();
    mostrarToast(`Backup gerado: ${nome}`, { duracao: 7000 });
    renderInfoBackup();
    avisarMudanca(); // o aviso de "faça backup" no Início deve sumir
  } catch (e) {
    tratarErro(e);
  }
}

async function aoEscolherArquivo(evento) {
  const entrada = evento.target;
  const arquivo = entrada.files[0];
  entrada.value = ''; // permite escolher o mesmo arquivo de novo depois
  if (!arquivo) return;

  try {
    if (arquivo.size > MAX_BACKUP_BYTES) {
      throw new Error('O arquivo é grande demais para ser um backup do app.');
    }

    // Confere TUDO antes de tocar nos dados atuais
    const backup = parseBackup(await arquivo.text());
    const c = backup.counts;

    let origem = '';
    const quando = new Date(backup.exportedAt);
    if (backup.exportedAt && !Number.isNaN(quando.getTime())) {
      origem = `, do backup de ${formatarData(dataLocalISO(quando))}`;
    }

    const ok = await confirmar({
      titulo: 'Restaurar backup?',
      mensagem:
        `Isto vai SUBSTITUIR todos os dados atuais por: ${c.expenses} gastos, ` +
        `${c.installmentPlans} compras parceladas (${c.installments} parcelas) e ` +
        `${c.events} compromissos${origem}. Dica: exporte um backup dos dados atuais antes.`,
      rotuloConfirmar: 'Substituir tudo',
      perigo: true,
    });
    if (!ok) return;

    await restoreBackup(backup);
    // Uma edição aberta apontaria para um id que agora é outro registro
    cancelarEdicaoGasto();
    cancelarEdicaoEvento();
    avisarMudanca();
    mostrarToast('Backup restaurado.');
  } catch (e) {
    tratarErro(e);
  }
}

// ---------------------------------------------------------
// Armazenamento
// ---------------------------------------------------------

function formatarBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

async function renderArmazenamento() {
  const nota = $('status-armazenamento');
  const botao = $('btn-persistir');

  if (!navigator.storage?.persisted) {
    nota.textContent = 'Este navegador não informa o estado do armazenamento.';
    botao.hidden = true;
    return;
  }

  const persistente = await navigator.storage.persisted();
  let uso = '';
  try {
    const estimativa = await navigator.storage.estimate();
    if (typeof estimativa.usage === 'number') uso = ` Uso atual: ${formatarBytes(estimativa.usage)}.`;
  } catch {
    /* estimativa indisponível: seguimos sem ela */
  }

  nota.textContent = persistente
    ? 'Armazenamento protegido: o navegador não apaga seus dados sozinho quando falta espaço.' + uso
    : 'Armazenamento comum: em situações raras (pouco espaço no aparelho) o navegador pode apagar os dados do site. Peça a proteção abaixo e mantenha backups.' +
      uso;
  botao.hidden = persistente || !navigator.storage.persist;
}

async function pedirPersistencia() {
  try {
    const ok = await navigator.storage.persist();
    mostrarToast(
      ok
        ? 'Armazenamento protegido.'
        : 'O navegador não concedeu a proteção. Instalar o app na tela inicial costuma ajudar.',
      { duracao: 6000 }
    );
    await renderArmazenamento();
  } catch (e) {
    tratarErro(e);
  }
}

// ---------------------------------------------------------
// PIN
// ---------------------------------------------------------

function renderPin() {
  const ativo = pinEnabled();
  const suportado = pinSupported();

  $('status-pin').textContent = !suportado
    ? 'O PIN só funciona em HTTPS ou em localhost neste navegador.'
    : ativo
      ? 'PIN ativado. O app pede o PIN ao abrir e depois de 1 minuto fora da tela. É uma tranca de tela, não criptografia.'
      : 'PIN desativado.';

  $('campo-pin-atual').hidden = !ativo;
  $('pin-salvar').textContent = ativo ? 'Alterar PIN' : 'Ativar PIN';
  $('pin-salvar').disabled = !suportado;
  $('btn-bloquear-agora').hidden = !ativo;
  $('pin-remover').hidden = !ativo;
}

function limparCamposPin() {
  for (const id of ['pin-atual', 'pin-novo', 'pin-confirmar']) $(id).value = '';
}

async function salvarPin(evento) {
  evento.preventDefault();
  const erro = $('pin-erro');
  limparErroForm(erro);

  try {
    const novo = $('pin-novo').value;
    if (!validatePinFormat(novo)) throw new Error('O PIN deve ter de 4 a 6 números.');
    if (novo !== $('pin-confirmar').value) throw new Error('A confirmação do PIN não confere.');

    await setPin(novo, $('pin-atual').value);
    limparCamposPin();
    renderPin();
    mostrarToast('PIN salvo.');
  } catch (e) {
    mostrarErroForm(erro, e.message);
  }
}

async function removerPin() {
  const erro = $('pin-erro');
  limparErroForm(erro);

  try {
    const ok = await confirmar({
      titulo: 'Remover o PIN?',
      mensagem: 'O app deixará de pedir PIN ao abrir. Digite o PIN atual no campo antes de confirmar.',
      rotuloConfirmar: 'Remover PIN',
      perigo: true,
    });
    if (!ok) return;

    await removePin($('pin-atual').value);
    limparCamposPin();
    renderPin();
    mostrarToast('PIN removido.');
  } catch (e) {
    mostrarErroForm(erro, e.message);
  }
}
