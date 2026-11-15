// ==========================================================
// service-worker.js — cache e funcionamento offline
//
// O Service Worker é um script que o navegador roda "ao lado" da
// página e que intercepta os pedidos de arquivos (fetch).
//
// ESTRATÉGIA: "rede primeiro, cache como reserva"
//   - Online (ex.: no Live Server): busca o arquivo da rede, entrega
//     e guarda uma cópia. Você sempre vê a versão mais nova do código
//     enquanto desenvolve — sem o problema clássico de "mudei o
//     arquivo e nada mudou".
//   - Offline (servidor desligado ou sem internet): entrega a cópia
//     guardada. É isso que permite abrir o app sem servidor.
//   - Se a rede demorar mais de 4 s, usa o cache (rede "meia boca").
//
// QUANDO MEXER AQUI: ao criar um arquivo novo no projeto, acrescente-o
// em ARQUIVOS e AUMENTE a VERSAO. Isso renova o cache dos usuários.
// ==========================================================

const VERSAO = 'v1';
const NOME_CACHE = `meu-organizador-${VERSAO}`;
const TEMPO_LIMITE_REDE_MS = 4000;

// Tudo que o app precisa para abrir offline.
const ARQUIVOS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/nav.js',
  './js/ui.js',
  './js/utils.js',
  './js/database.js',
  './js/expenses.js',
  './js/installments.js',
  './js/calendar.js',
  './js/backup.js',
  './js/security.js',
  './js/views/dashboard.js',
  './js/views/gastos.js',
  './js/views/parcelas.js',
  './js/views/agenda.js',
  './js/views/ajustes.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
];

// INSTALAÇÃO: guarda todos os arquivos no cache.
// cache: 'reload' ignora o cache HTTP do navegador e pega a versão real.
self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches
      .open(NOME_CACHE)
      .then((cache) => cache.addAll(ARQUIVOS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()) // a versão nova assume sem esperar fechar o app
  );
});

// ATIVAÇÃO: apaga caches de versões antigas e assume o controle das abas abertas.
self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((nomes) =>
        Promise.all(nomes.filter((n) => n.startsWith('meu-organizador-') && n !== NOME_CACHE).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

// Pedidos de arquivos: rede primeiro, cache como reserva.
self.addEventListener('fetch', (evento) => {
  const pedido = evento.request;
  const url = new URL(pedido.url);

  // Só tratamos GET do próprio app (nunca interceptamos outros sites)
  if (pedido.method !== 'GET' || url.origin !== self.location.origin) return;

  evento.respondWith(redePrimeiro(pedido, evento));
});

async function redePrimeiro(pedido, evento) {
  const cache = await caches.open(NOME_CACHE);

  try {
    const resposta = await comLimiteDeTempo(fetch(pedido), TEMPO_LIMITE_REDE_MS);
    // Guarda cópia só de respostas completas (200). 404 e respostas parciais (206) nunca entram.
    // waitUntil impede o navegador de encerrar o Service Worker antes de terminar de gravar.
    if (resposta.status === 200) {
      evento.waitUntil(cache.put(pedido, resposta.clone()).catch(() => {}));
    }
    return resposta;
  } catch {
    // Sem rede (ou rede lenta demais): usa o que foi guardado.
    const guardada = await cache.match(pedido, { ignoreSearch: true });
    if (guardada) return guardada;

    // Navegação para uma página desconhecida: abre o app.
    if (pedido.mode === 'navigate') {
      const inicio = await cache.match('./index.html');
      if (inicio) return inicio;
    }
    return new Response('Sem conexão e arquivo não está no cache.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

function comLimiteDeTempo(promessa, ms) {
  return new Promise((resolve, reject) => {
    const relogio = setTimeout(() => reject(new Error('tempo esgotado')), ms);
    promessa.then(
      (v) => {
        clearTimeout(relogio);
        resolve(v);
      },
      (e) => {
        clearTimeout(relogio);
        reject(e);
      }
    );
  });
}

// Toque numa notificação de lembrete: traz o app para a frente (ou abre).
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if ('focus' in janela) return janela.focus();
      }
      return self.clients.openWindow('./index.html');
    })
  );
});
