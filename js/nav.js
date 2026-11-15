// ==========================================================
// nav.js — navegação entre telas
// Responsabilidade: mostrar uma tela e esconder as outras, e
// destacar o botão do menu correspondente. Não conhece os dados.
// ==========================================================

const TELAS = ['inicio', 'gastos', 'parcelas', 'agenda', 'ajustes'];

/**
 * Mostra a tela pedida.
 * @param {string} nome    - 'inicio', 'gastos', 'parcelas', 'agenda' ou 'ajustes'
 * @param {string} [focoId] - id de um campo que deve receber o cursor
 */
export function irParaTela(nome, focoId = null) {
  if (!TELAS.includes(nome)) return;

  document.querySelectorAll('.tela').forEach((t) => t.classList.remove('tela--ativa'));
  document.getElementById('tela-' + nome)?.classList.add('tela--ativa');

  document.querySelectorAll('.menu__item').forEach((botao) => {
    botao.classList.toggle('menu__item--ativo', botao.dataset.tela === nome);
  });
  document.getElementById('btn-ajustes')?.classList.toggle('icone-btn--ativo', nome === 'ajustes');

  window.scrollTo({ top: 0 });
  if (focoId) document.getElementById(focoId)?.focus();
}

/** Liga os cliques do menu inferior, da engrenagem e dos atalhos do Início. */
export function iniciarNavegacao() {
  document.querySelectorAll('.menu__item').forEach((botao) => {
    botao.addEventListener('click', () => irParaTela(botao.dataset.tela));
  });

  document.getElementById('btn-ajustes').addEventListener('click', () => irParaTela('ajustes'));

  // Atalhos: data-ir-para = tela de destino, data-foco = campo a focar
  document.querySelectorAll('[data-ir-para]').forEach((atalho) => {
    atalho.addEventListener('click', () => irParaTela(atalho.dataset.irPara, atalho.dataset.foco));
  });
}
