// Página da rede do bairro para quem não tem a coleira (vizinhos).
import { configurado } from './perfil-dados.js';
import { exigirLogin, sair } from './conta.js';
import { montarComunidade } from './comunidade-ui.js';
import { AREA_PADRAO } from './firebase-config.js';
import { registrarServiceWorker } from './pwa.js';

registrarServiceWorker();

const $ = (id) => document.getElementById(id);
const avisos = [];
function avisar(texto) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('Rede do bairro', { body: texto }); } catch { /* ok */ }
  }
  avisos.push(texto);
}

async function iniciar() {
  if (configurado) {
    const u = await exigirLogin({
      titulo: 'Rede de alerta do bairro',
      texto: 'Entre ou crie uma conta para receber alertas de pets perdidos perto de você. Ninguém vê o seu e-mail nem onde você mora.'
    });
    $('contaLateral').hidden = false;
    $('contaEmail').textContent = u.email;
    $('btnSair').addEventListener('click', () => sair());
  }
  // na simulação, oferece a região de exemplo (a mesma da área segura padrão)
  await montarComunidade($('comunidade'), { area: configurado ? null : AREA_PADRAO, avisar });
}
iniciar().catch((err) => {
  console.error(err);
  $('comunidade').textContent = 'Não foi possível abrir a rede do bairro: ' + err.message;
});
