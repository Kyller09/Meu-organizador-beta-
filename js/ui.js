// ==========================================================
// ui.js — peças de interface reutilizáveis
// Responsabilidade: criar elementos HTML com segurança, mostrar
// avisos (toast), pedir confirmação e avisar as telas quando os
// dados mudam. Não conhece despesas, parcelas nem agenda.
//
// REGRA DE SEGURANÇA DO PROJETO
//   Nunca monte HTML juntando texto do usuário numa string
//   (ex.: `<li>${descricao}</li>` com innerHTML). Se a descrição
//   tiver <script> ou <img onerror=...>, o navegador executaria.
//   Aqui criamos os elementos com el() e usamos textContent, que
//   trata qualquer texto como TEXTO, nunca como HTML.
// ==========================================================

/**
 * Cria um elemento HTML.
 *   el('p', { class: 'nota', text: 'Oi' })
 *   el('button', { type: 'button', onclick: fazer }, 'Salvar')
 *   el('ul', {}, itens.map((i) => el('li', {}, i.nome)))
 *
 * Propriedades especiais:
 *   class   -> className
 *   text    -> textContent (texto puro, seguro)
 *   dataset -> atributos data-*   ({ dataset: { id: 3 } })
 *   onclick, onchange... -> ouvintes de evento
 * Valores null / undefined / false são ignorados; true vira atributo
 * sem valor (ex.: { hidden: true }).
 * Os filhos podem ser textos, elementos ou listas (listas são "achatadas").
 */
export function el(tag, props = {}, ...filhos) {
  const no = document.createElement(tag);

  for (const [chave, valor] of Object.entries(props)) {
    if (valor === null || valor === undefined || valor === false) continue;

    if (chave === 'class') {
      no.className = valor;
    } else if (chave === 'text') {
      no.textContent = valor;
    } else if (chave === 'dataset') {
      Object.assign(no.dataset, valor);
    } else if (chave.startsWith('on') && typeof valor === 'function') {
      no.addEventListener(chave.slice(2).toLowerCase(), valor);
    } else if (valor === true) {
      no.setAttribute(chave, '');
    } else {
      no.setAttribute(chave, String(valor));
    }
  }

  for (const filho of filhos.flat(Infinity)) {
    if (filho === null || filho === undefined || filho === false) continue;
    no.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
  }
  return no;
}

/** Esvazia um elemento. */
export function limpar(no) {
  no.replaceChildren();
}

/**
 * Preenche um <select>. `opcoes` é [{ value, label }].
 * Se `selecionado` for informado, já deixa essa opção escolhida.
 */
export function preencherSelect(select, opcoes, selecionado) {
  select.replaceChildren(...opcoes.map((o) => el('option', { value: o.value }, o.label)));
  if (selecionado !== undefined) select.value = selecionado;
}

// ---------------------------------------------------------
// Erros em formulários
// ---------------------------------------------------------

/** Mostra a mensagem de erro embaixo de um formulário. */
export function mostrarErroForm(elementoErro, mensagem) {
  elementoErro.textContent = mensagem;
  elementoErro.hidden = false;
}

/** Esconde a mensagem de erro de um formulário. */
export function limparErroForm(elementoErro) {
  elementoErro.textContent = '';
  elementoErro.hidden = true;
}

// ---------------------------------------------------------
// Toast (aviso rápido, com botão opcional "Desfazer")
// ---------------------------------------------------------

/**
 * Mostra um aviso que some sozinho.
 *   mostrarToast('Gasto excluído.', {
 *     acaoRotulo: 'Desfazer',
 *     aoAcionar: async () => { ... },
 *     duracao: 7000,
 *   })
 */
export function mostrarToast(mensagem, { acaoRotulo = null, aoAcionar = null, duracao = 5000 } = {}) {
  const caixa = document.getElementById('toasts');
  if (!caixa) return;

  // No máximo 3 avisos na tela: remove o mais antigo
  while (caixa.children.length >= 3) caixa.firstElementChild.remove();

  const toast = el('div', { class: 'toast', role: 'status' }, el('span', { text: mensagem }));

  if (acaoRotulo && aoAcionar) {
    toast.append(
      el('button', {
        type: 'button',
        class: 'toast__acao',
        text: acaoRotulo,
        onclick: async () => {
          toast.remove();
          try {
            await aoAcionar();
          } catch (erro) {
            tratarErro(erro);
          }
        },
      })
    );
  }

  caixa.append(toast);
  setTimeout(() => toast.remove(), duracao);
}

/** Mostra o erro para o usuário (toast) e registra no console para depuração. */
export function tratarErro(erro) {
  console.error(erro);
  mostrarToast(erro?.message || 'Algo deu errado. Tente novamente.', { duracao: 6000 });
}

// ---------------------------------------------------------
// Diálogo de confirmação
// ---------------------------------------------------------

/**
 * Pergunta "tem certeza?". Devolve uma Promise: true se confirmou.
 *   if (await confirmar({ titulo: 'Excluir?', mensagem: '...', perigo: true })) { ... }
 */
export function confirmar({ titulo, mensagem, rotuloConfirmar = 'Confirmar', perigo = false }) {
  const dialogo = document.getElementById('dialogo-confirmar');

  // Navegador muito antigo sem <dialog>: usa a caixa padrão
  if (!dialogo || typeof dialogo.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${titulo}\n\n${mensagem}`));
  }
  if (dialogo.open) return Promise.resolve(false);

  document.getElementById('dialogo-titulo').textContent = titulo;
  document.getElementById('dialogo-mensagem').textContent = mensagem;

  const botaoOk = document.getElementById('dialogo-ok');
  botaoOk.textContent = rotuloConfirmar;
  botaoOk.classList.toggle('btn--perigo', perigo);
  botaoOk.classList.toggle('btn--primario', !perigo);

  dialogo.returnValue = ''; // se fechar com "Esc", o resultado fica vazio = não confirmou

  return new Promise((resolve) => {
    dialogo.addEventListener('close', () => resolve(dialogo.returnValue === 'ok'), { once: true });
    dialogo.showModal();
  });
}

// ---------------------------------------------------------
// Aviso de "os dados mudaram"
// ---------------------------------------------------------
// Quando uma tela grava algo, ela chama avisarMudanca(). O app.js
// escuta e redesenha TODAS as telas. Assim, pagar uma parcela atualiza
// também o Início e os Gastos, sem uma tela precisar conhecer a outra.

const EVENTO_MUDANCA = 'dados-alterados';

/** Avisa que os dados mudaram. */
export function avisarMudanca() {
  document.dispatchEvent(new CustomEvent(EVENTO_MUDANCA));
}

/** Registra quem quer ser avisado quando os dados mudarem. */
export function aoMudarDados(funcao) {
  document.addEventListener(EVENTO_MUDANCA, funcao);
}
