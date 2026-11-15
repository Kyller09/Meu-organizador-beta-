// ==========================================================
// security.js — bloqueio por PIN
// Responsabilidade: definir/remover/verificar um PIN e controlar a
// tela de bloqueio.
//
// O QUE ISTO É (e o que NÃO é)
//   É uma "tranca de tela": impede que alguém que pegue seu celular
//   desbloqueado abra o app e veja seus gastos.
//   NÃO criptografa os dados. Quem tiver acesso técnico ao navegador
//   (DevTools, por exemplo) consegue ler o IndexedDB. Para proteger
//   o aparelho de verdade, use o bloqueio de tela do Android.
//
// COMO O PIN É GUARDADO
//   Nunca guardamos o PIN. Guardamos só uma "impressão digital" dele
//   (hash PBKDF2-SHA256, 150 mil iterações, com um sal aleatório) no
//   localStorage. Dá para conferir se um PIN bate, mas não dá para
//   recuperar o PIN a partir do hash.
//
// BIOMETRIA: avaliada e NÃO implementada. A forma web de fazer isso é
//   WebAuthn (autenticador da plataforma), que exige mais infraestrutura
//   e tem suporte irregular em PWAs. Fica como evolução futura.
//
// ESQUECEU O PIN? Não há recuperação. Limpar os dados do site no Chrome
//   remove o PIN, mas também APAGA todos os registros — por isso faça
//   backup (Ajustes) regularmente.
// ==========================================================

const CHAVE_PIN = 'mo.pin';
const CHAVE_FALHAS = 'mo.pin.falhas';
const ITERACOES = 150000;
const MAX_FALHAS = 5; // erros seguidos até travar por um tempo
const ESPERA_MS = 30 * 1000; // quanto tempo fica travado
const AUTO_BLOQUEIO_MS = 60 * 1000; // volta a pedir PIN se ficou ausente mais que isso

// ---------------------------------------------------------
// PIN: guardar e conferir
// ---------------------------------------------------------

/** O navegador tem a API de criptografia? (só em HTTPS ou localhost) */
export function pinSupported() {
  return Boolean(globalThis.crypto?.subtle);
}

/** Existe um PIN configurado? */
export function pinEnabled() {
  return lerConfig() !== null;
}

/** O PIN precisa ter de 4 a 6 dígitos numéricos. */
export function validatePinFormat(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

/**
 * Define (ou troca) o PIN. Se já existe um PIN, é preciso informar o
 * atual. Lança Error com mensagem em português se algo estiver errado.
 */
export async function setPin(novoPin, pinAtual = '') {
  if (!pinSupported()) {
    throw new Error('O PIN só funciona em HTTPS ou em localhost neste navegador.');
  }
  if (!validatePinFormat(novoPin)) {
    throw new Error('O PIN deve ter de 4 a 6 números.');
  }
  if (pinEnabled() && !(await verifyPin(pinAtual))) {
    throw new Error('PIN atual incorreto.');
  }

  const sal = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivar(novoPin, sal, ITERACOES);
  localStorage.setItem(
    CHAVE_PIN,
    JSON.stringify({ salt: paraHex(sal), hash, iterations: ITERACOES })
  );
  localStorage.removeItem(CHAVE_FALHAS);
}

/** Remove o PIN (exige o PIN atual). */
export async function removePin(pinAtual) {
  if (!pinEnabled()) return;
  if (!(await verifyPin(pinAtual))) {
    throw new Error('PIN incorreto.');
  }
  localStorage.removeItem(CHAVE_PIN);
  localStorage.removeItem(CHAVE_FALHAS);
}

/**
 * Confere um PIN. Devolve true/false.
 * Depois de 5 erros seguidos, trava por 30 s (lança Error dizendo
 * quanto falta). O contador fica no localStorage, então recarregar a
 * página não zera.
 */
export async function verifyPin(pin) {
  const config = lerConfig();
  if (!config) return true; // sem PIN configurado, nada a conferir
  if (!pinSupported()) {
    throw new Error('Não é possível conferir o PIN neste endereço (precisa de HTTPS ou localhost).');
  }

  const falhas = lerFalhas();
  const agora = Date.now();
  if (falhas.ate > agora) {
    const segundos = Math.ceil((falhas.ate - agora) / 1000);
    throw new Error(`Muitas tentativas. Aguarde ${segundos} s.`);
  }

  const hash = await derivar(String(pin), deHex(config.salt), config.iterations);
  const ok = compararTextos(hash, config.hash);

  if (ok) {
    localStorage.removeItem(CHAVE_FALHAS);
    return true;
  }

  // Relemos o contador depois da espera do PBKDF2: se duas tentativas
  // foram enviadas juntas, cada uma precisa contar.
  const contagem = lerFalhas().contagem + 1;
  salvarFalhas(
    contagem >= MAX_FALHAS
      ? { contagem: 0, ate: Date.now() + ESPERA_MS }
      : { contagem, ate: 0 }
  );
  return false;
}

// ---------------------------------------------------------
// Tela de bloqueio
// ---------------------------------------------------------

let pendente = null; // { promise, resolver } enquanto estiver bloqueado
let ligado = false;
let ausenteDesde = null;

/**
 * Chame uma vez na abertura do app. Devolve uma Promise que só termina
 * quando o app estiver liberado (na hora, se não houver PIN).
 */
export function iniciarSeguranca() {
  ligarEventos();
  return pinEnabled() ? bloquear() : Promise.resolve();
}

/** Mostra a tela de bloqueio (se houver PIN). Termina quando desbloquear. */
export function bloquear() {
  if (!pinEnabled()) return Promise.resolve();
  if (pendente) return pendente.promise;

  const tela = document.getElementById('tela-bloqueio');
  tela.hidden = false;
  document.body.classList.add('bloqueado');

  // Um diálogo de confirmação aberto ficaria por cima da tela de bloqueio
  // (ele fica na "camada superior" do navegador): fechamos antes.
  const dialogo = document.getElementById('dialogo-confirmar');
  if (dialogo?.open) dialogo.close();

  let resolver;
  const promise = new Promise((resolve) => {
    resolver = resolve;
  });
  pendente = { promise, resolver };

  if (!pinSupported()) {
    mostrarErro('Neste endereço não dá para conferir o PIN. Abra o app por HTTPS ou localhost.');
  }
  setTimeout(() => document.getElementById('bloqueio-pin')?.focus(), 50);
  return promise;
}

function desbloquear() {
  document.getElementById('tela-bloqueio').hidden = true;
  document.body.classList.remove('bloqueado');
  document.getElementById('bloqueio-pin').value = '';
  limparErro();

  const atual = pendente;
  pendente = null;
  atual?.resolver();
}

function ligarEventos() {
  if (ligado) return;
  ligado = true;

  let verificando = false; // ignora um 2º envio enquanto o 1º ainda está sendo conferido
  document.getElementById('form-bloqueio').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (verificando) return;
    verificando = true;
    const campo = document.getElementById('bloqueio-pin');
    limparErro();
    try {
      if (await verifyPin(campo.value)) {
        desbloquear();
      } else {
        mostrarErro('PIN incorreto.');
        campo.value = '';
      }
    } catch (erro) {
      mostrarErro(erro.message);
      campo.value = '';
    } finally {
      verificando = false;
    }
  });

  // Bloqueio automático: se o app ficou em segundo plano por mais de
  // 1 minuto, pede o PIN de novo ao voltar.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      ausenteDesde = Date.now();
    } else if (ausenteDesde !== null) {
      const ausencia = Date.now() - ausenteDesde;
      ausenteDesde = null;
      if (pinEnabled() && ausencia > AUTO_BLOQUEIO_MS) bloquear();
    }
  });
}

function mostrarErro(mensagem) {
  const erro = document.getElementById('bloqueio-erro');
  erro.textContent = mensagem;
  erro.hidden = false;
}

function limparErro() {
  const erro = document.getElementById('bloqueio-erro');
  erro.textContent = '';
  erro.hidden = true;
}

// ---------------------------------------------------------
// Funções internas
// ---------------------------------------------------------

function lerConfig() {
  try {
    const texto = localStorage.getItem(CHAVE_PIN);
    if (!texto) return null;
    const config = JSON.parse(texto);
    if (
      config &&
      typeof config.salt === 'string' &&
      typeof config.hash === 'string' &&
      Number.isInteger(config.iterations)
    ) {
      return config;
    }
  } catch {
    /* config corrompida: tratamos como "sem PIN" */
  }
  return null;
}

function lerFalhas() {
  try {
    const f = JSON.parse(localStorage.getItem(CHAVE_FALHAS));
    if (f && Number.isInteger(f.contagem) && Number.isFinite(f.ate)) return f;
  } catch {
    /* ignora */
  }
  return { contagem: 0, ate: 0 };
}

function salvarFalhas(falhas) {
  localStorage.setItem(CHAVE_FALHAS, JSON.stringify(falhas));
}

/** PBKDF2-SHA256: transforma PIN + sal na "impressão digital" (texto hex). */
async function derivar(pin, sal, iteracoes) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: sal, iterations: iteracoes, hash: 'SHA-256' },
    material,
    256
  );
  return paraHex(new Uint8Array(bits));
}

function paraHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function deHex(texto) {
  const pares = texto.match(/../g) ?? [];
  return new Uint8Array(pares.map((par) => parseInt(par, 16)));
}

/** Compara dois textos sem parar no primeiro caractere diferente. */
function compararTextos(a, b) {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i += 1) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diferenca === 0;
}
