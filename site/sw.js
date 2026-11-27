// Service worker: deixa o site abrir sem internet e instalar como app.
//
// Estratégia:
//   arquivos do próprio site   rede primeiro (sempre a versão nova); sem internet, a cópia guardada
//   bibliotecas de CDN          cache primeiro (as URLs têm versão fixa, nunca mudam)
//   blocos do mapa              cópia guardada na hora e atualizada por trás (até 300 blocos)
//   Firebase (dados, login)     nunca passa por aqui: o próprio SDK guarda os dados offline
const VERSAO = 'vitalar-v2';
const SITE = VERSAO + '-site';
const LIBS = VERSAO + '-libs';
const MAPA = VERSAO + '-mapa';

const ESSENCIAIS = [
  './', 'index.html', 'perdido.html', 'bairro.html', 'style.css', 'manifest.webmanifest',
  'script.js', 'perdido.js', 'bairro.js', 'conta.js', 'comunidade.js', 'comunidade-ui.js', 'encontros.js',
  'perfil-dados.js', 'saude.js', 'area.js', 'movimento.js', 'ajustes.js', 'pwa.js', 'firebase-config.js',
  'icones/icone-192.png', 'icones/icone-512.png', 'icones/apple-touch-icon.png', 'icones/favicon-32.png', 'icones/icone.svg', 'icones/favicon.svg', 'icones/marca.svg'
];
const HOSTS_LIBS = ['unpkg.com', 'cdnjs.cloudflare.com', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(SITE).then((c) => c.addAll(ESSENCIAIS)));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((n) => !n.startsWith(VERSAO)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// a página pede para trocar já para a versão nova
self.addEventListener('message', (ev) => { if (ev.data === 'atualizar') self.skipWaiting(); });

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    ev.respondWith(redePrimeiro(req));
    return;
  }
  if (HOSTS_LIBS.includes(url.hostname)) { ev.respondWith(cachePrimeiro(req, LIBS)); return; }
  if (url.hostname.endsWith('tile.openstreetmap.org')) { ev.respondWith(blocoDoMapa(req)); return; }
  // todo o resto (Firestore, login, WhatsApp...) vai direto para a rede
});

async function redePrimeiro(req) {
  const cache = await caches.open(SITE);
  try {
    const resp = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 6000))
    ]);
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    // ?v=... muda a cada versão: sem internet vale a última cópia de qualquer versão
    const guardada = await cache.match(req, { ignoreSearch: true });
    if (guardada) return guardada;
    if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  }
}

async function cachePrimeiro(req, nome) {
  const cache = await caches.open(nome);
  const guardada = await cache.match(req);
  if (guardada) return guardada;
  const resp = await fetch(req);
  if (resp.ok || resp.type === 'opaque') cache.put(req, resp.clone());
  return resp;
}

async function blocoDoMapa(req) {
  const cache = await caches.open(MAPA);
  const guardada = await cache.match(req);
  const buscar = fetch(req).then(async (resp) => {
    if (resp.ok || resp.type === 'opaque') {
      await cache.put(req, resp.clone());
      const chaves = await cache.keys();
      if (chaves.length > 300) await Promise.all(chaves.slice(0, chaves.length - 300).map((k) => cache.delete(k)));
    }
    return resp;
  }).catch(() => guardada || Response.error());
  return guardada || buscar;
}
