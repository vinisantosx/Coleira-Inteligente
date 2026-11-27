// Instalação como app (PWA): registra o service worker, mostra o botão
// "Instalar app" quando o navegador permite, explica o passo a passo no iPhone
// e avisa quando há uma versão nova do site.
const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ehIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let pedido = null;           // evento guardado para abrir a janela de instalação depois
const ouvintes = new Set();
const estado = () => ({ instalado: instalado(), podeInstalar: !!pedido, ios: ehIOS() && !instalado() });
const avisar = () => ouvintes.forEach((f) => f(estado()));

// cb({ instalado, podeInstalar, ios }) é chamado agora e quando algo muda
export function acompanharInstalacao(cb) { ouvintes.add(cb); cb(estado()); }

export async function instalar() {
  if (!pedido) return false;
  pedido.prompt();
  const { outcome } = await pedido.userChoice;
  pedido = null;
  avisar();
  return outcome === 'accepted';
}

window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); pedido = ev; avisar(); });
window.addEventListener('appinstalled', () => { pedido = null; avisar(); });
matchMedia('(display-mode: standalone)').addEventListener?.('change', avisar);

// aoAtualizar(confirmar): chamado quando há versão nova; confirmar() troca e recarrega
export function registrarServiceWorker(aoAtualizar) {
  if (!('serviceWorker' in navigator)) return;
  // em testes locais com ?semsw o service worker fica desligado
  if (new URLSearchParams(location.search).has('semsw')) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      const oferecer = (sw) => aoAtualizar?.(() => sw.postMessage('atualizar'));
      if (reg.waiting && navigator.serviceWorker.controller) oferecer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const novo = reg.installing;
        novo?.addEventListener('statechange', () => {
          if (novo.state === 'installed' && navigator.serviceWorker.controller) oferecer(novo);
        });
      });
      let recarregou = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (recarregou) return;
        recarregou = true;
        location.reload();
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);   // confere de hora em hora
    } catch (err) { console.warn('service worker', err); }
  });
}

// cor da barra do sistema acompanha o tema escolhido em Configurações
export function corDaBarra(cor) {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
  if (cor) meta.content = cor;
}
