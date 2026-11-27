// Rede de alerta do bairro: interface. Usada no painel do tutor (index.html)
// e na página aberta para vizinhos sem coleira (bairro.html).
import {
  iniciarComunidade, emSimulacao, lerVizinho, salvarVizinho, sairDaRede, ouvirAlertasPerto, ouvirAjudantes,
  estouProcurando, enviarAvistamento, denunciar, ouvirMeuAlerta, ouvirAvistamentos, publicarAlerta, encerrarAlerta,
  simularVizinhos, celulaDe, centroCelula, distanciaKm, RAIO_AREA_M, souEu
} from './comunidade.js';
import { urlPaginaQR } from './perfil-dados.js';
import {
  iniciarSelos, selosDe, seloChip, reconhecer, retirarReconhecimento, reconhecimentosQueDei, idReconhecimento,
  aoMudarSelos, meuUidSelos
} from './selos.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fotoSegura = (f) => (typeof f === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(f) ? f : '');
const hora = (d) => (d ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const quando = (d) => {
  if (!d) return '';
  const hoje = new Date().toDateString() === d.toDateString();
  return hoje ? `hoje às ${hora(d)}` : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hora(d)}`;
};
const linkRota = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
function pegarLocal() {
  return new Promise((ok, erro) => {
    if (!('geolocation' in navigator)) return erro(new Error('Este navegador não informa a localização.'));
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, precisao: p.coords.accuracy }),
      (e) => erro(new Error(e.code === 1 ? 'Você não permitiu o acesso à localização.' : 'Não consegui obter a localização.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

const MOLDE = `
<section class="cartao bz-entrar" data-bz="entrar" hidden>
  <h2><svg class="h-icone" aria-hidden="true"><use href="#i-vizinhos"/></svg>Entre na rede de alerta do bairro</h2>
  <p class="dica">Quando um pet some perto de você, você recebe o alerta e pode ajudar a procurar. Quando for o seu, os vizinhos ajudam você.</p>
  <ul class="bz-garantias">
    <li><span><b>Ninguém vê onde você mora.</b> Guardamos só uma área de cerca de 1 km e o seu apelido.</span></li>
    <li><span><b>Só aparecem pets perdidos</b>, sempre com área aproximada. Pets em casa nunca aparecem.</span></li>
    <li><span><b>Quando você avisa onde viu um pet</b>, só o tutor vê o ponto exato.</span></li>
  </ul>
  <form class="bz-form" data-bz="formEntrar" novalidate>
    <div class="qr-duas">
      <label class="campo">Apelido (é o que os vizinhos veem) <input name="apelido" maxlength="30" autocomplete="nickname" placeholder="Ex.: Ana do 302"></label>
      <label class="campo">Bairro <input name="bairro" maxlength="50" placeholder="Ex.: Centro"></label>
    </div>
    <div class="bz-local">
      <button type="button" class="pilula leve" data-bz="btnArea" hidden><svg aria-hidden="true"><use href="#i-casa"/></svg>Usar a região da área segura</button>
      <button type="button" class="pilula leve" data-bz="btnLocal"><svg aria-hidden="true"><use href="#i-mapa"/></svg>Usar minha localização aproximada</button>
      <span class="dica" data-bz="localTexto">Escolha uma opção para marcar sua região.</span>
    </div>
    <label class="campo">Receber alertas num raio de
      <select name="raio"><option value="1">1 km</option><option value="2" selected>2 km</option><option value="3">3 km</option></select>
    </label>
    <label class="bz-check"><input type="checkbox" name="regras"> <span>Aceito as regras da rede: não pedir nem oferecer dinheiro, não divulgar o endereço de ninguém e só publicar alertas verdadeiros.</span></label>
    <div class="bz-linha">
      <button class="pilula primario" type="submit"><svg aria-hidden="true"><use href="#i-vizinhos"/></svg><span data-bz="txtEntrar">Entrar na rede</span></button>
      <button class="pilula leve" type="button" data-bz="btnCancelarEdicao" hidden>Cancelar</button>
    </div>
    <p class="qr-status" data-bz="erroEntrar" role="status"></p>
  </form>
</section>

<div class="bz-grade" data-bz="painel" hidden>
  <div class="bz-principal">
    <section class="cartao bz-meu" data-bz="meuAlerta" hidden></section>
    <section class="cartao bz-alertas">
      <h2><svg class="h-icone" aria-hidden="true"><use href="#i-megafone"/></svg>Pets perdidos perto de você</h2>
      <p class="dica" data-bz="resumo"></p>
      <div class="bz-mapa" data-bz="mapa" role="img" aria-label="Mapa com as áreas aproximadas dos pets perdidos"></div>
      <div class="bz-lista" data-bz="lista"></div>
    </section>
  </div>
  <div class="bz-lateral">
    <section class="cartao bz-regiao">
      <h2><svg class="h-icone" aria-hidden="true"><use href="#i-coracao"/></svg>Na sua região</h2>
      <div class="bz-numeros">
        <div><b data-bz="numVoltaram">0</b><span>pets voltaram para casa com ajuda da rede nos últimos 30 dias</span></div>
        <div><b data-bz="numAtivos">0</b><span>sendo procurados agora</span></div>
      </div>
    </section>
    <section class="cartao bz-eu">
      <h2><svg class="h-icone" aria-hidden="true"><use href="#i-vizinhos"/></svg>Minha participação</h2>
      <p data-bz="euTexto"></p>
      <label class="bz-check"><input type="checkbox" data-bz="chkNotif"> <span>Avisar neste aparelho quando um pet sumir perto de mim</span></label>
      <label class="bz-check" data-bz="linhaAuto" hidden><input type="checkbox" data-bz="chkAuto"> <span>Publicar o alerta do meu pet sozinho quando eu ativar o modo perdido</span></label>
      <div class="bz-linha">
        <button type="button" class="pilula leve" data-bz="btnEditar">Editar participação</button>
        <button type="button" class="pilula leve" data-bz="btnSair">Sair da rede</button>
      </div>
      <a class="pilula leve bz-convidar" data-bz="convidar" target="_blank" rel="noopener"><svg aria-hidden="true"><use href="#i-zap"/></svg>Convidar vizinhos</a>
    </section>
    <section class="cartao bz-seguranca">
      <h2><svg class="h-icone" aria-hidden="true"><use href="#i-cadeado"/></svg>Segurança contra golpes</h2>
      <ul>
        <li>Ninguém da rede pede dinheiro. <b>Nunca pague nada adiantado</b>, nem "taxa de transporte".</li>
        <li>Para confirmar que a pessoa está mesmo com o pet, peça <b>uma foto agora</b> ou um detalhe que só você sabe.</li>
        <li>Combine a entrega em <b>lugar público e movimentado</b> e vá acompanhado.</li>
        <li>Não publique endereço, valor do pet ou recompensa em dinheiro.</li>
        <li>Viu algo estranho? Use <b>Denunciar</b> no alerta.</li>
      </ul>
    </section>
  </div>
</div>`;

export async function montarComunidade(raiz, opcoes = {}) {
  // opcoes.pet: { id, nome(), foto(), perdido(), posicao() } quando é o painel do tutor
  // opcoes.area: { lat, lng } para "usar a região da área segura"
  // opcoes.avisar(texto): som/notificação; opcoes.aoContar(n): selo no menu
  const pet = opcoes.pet || null;
  await Promise.all([iniciarComunidade(), iniciarSelos()]);
  raiz.innerHTML = MOLDE;
  const $ = (n) => raiz.querySelector(`[data-bz="${n}"]`);

  let vizinho = null;
  let celulaEscolhida = null;
  let ativos = [], recuperados = [];
  let meuAlerta = null, meusAvist = [], meusAjud = [];
  const ajudantes = {};            // pet -> lista
  const pararAjud = {};
  // selos de boa ação: uid -> resumo (carregado aos poucos, sem repetir pedidos)
  const selos = {};
  const pedidos = new Set();
  let dei = new Set();             // ids de reconhecimentos que este tutor já deu (para o pet dele)
  function pedirSelos(uids) {
    const novos = [...new Set(uids)].filter((u) => u && !pedidos.has(u));
    if (!novos.length) return;
    novos.forEach((u) => pedidos.add(u));
    selosDe(novos).then((r) => { Object.assign(selos, r); if (vizinho) { renderLista(); renderMeu(); mostrarEu(); } })
      .catch((err) => console.error('selos', err));
  }
  const comSelo = (uid, apelido, curto = true) => `${esc(apelido)}${seloChip(selos[uid], { curto })}`;
  async function carregarDei() {
    if (!pet) return;
    try { dei = new Set((await reconhecimentosQueDei(pet.id)).map((r) => r.id)); } catch (err) { console.error('selos dados', err); }
    renderMeu();
  }
  aoMudarSelos(() => {
    Object.keys(selos).forEach((k) => delete selos[k]);
    pedidos.clear();
    carregarDei();
    if (vizinho) { renderLista(); mostrarEu(); }
  });
  let pararAlertas = null, pararMeu = null, pararAvist = null;
  let conhecidos = null;           // ids de alertas já vistos (para avisar só os novos)
  let mapa = null, camada = null, camadaEu = null;
  let viAberto = null;             // alerta com o formulário "vi este pet" aberto

  const notifLigada = () => { try { return localStorage.getItem('bz-notif') === '1'; } catch { return false; } };

  // ---------------------------------------------------------------- entrar / editar
  if (opcoes.area) $('btnArea').hidden = false;
  function marcarCelula(c, origem) {
    celulaEscolhida = c;
    $('localTexto').textContent = `Região marcada (${origem}). Guardamos só uma área de ~1 km, não o seu endereço.`;
    $('localTexto').className = 'dica ok';
  }
  $('btnArea').addEventListener('click', () => marcarCelula(celulaDe(opcoes.area.lat, opcoes.area.lng), 'área segura da coleira'));
  $('btnLocal').addEventListener('click', async () => {
    $('localTexto').textContent = 'Pegando a localização...';
    try { const p = await pegarLocal(); marcarCelula(celulaDe(p.lat, p.lng), 'sua localização'); }
    catch (err) { $('localTexto').textContent = err.message; $('localTexto').className = 'dica erro'; }
  });
  $('formEntrar').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const erro = (t) => { $('erroEntrar').textContent = t; $('erroEntrar').className = 'qr-status erro'; };
    if (f.apelido.value.trim().length < 2) return erro('Escolha um apelido com pelo menos 2 letras.');
    if (!f.bairro.value.trim()) return erro('Informe o bairro.');
    if (!celulaEscolhida) return erro('Marque a sua região (localização aproximada).');
    if (!f.regras.checked) return erro('Para entrar, aceite as regras da rede.');
    try {
      $('erroEntrar').textContent = 'Salvando...'; $('erroEntrar').className = 'qr-status';
      vizinho = await salvarVizinho({ apelido: f.apelido.value, bairro: f.bairro.value, celula: celulaEscolhida, raio: f.raio.value, autoPublicar: vizinho?.autoPublicar ?? !!pet });
      $('erroEntrar').textContent = '';
      mostrarPainel();
    } catch (err) { console.error(err); erro('Não foi possível salvar: ' + err.message); }
  });
  $('btnCancelarEdicao').addEventListener('click', mostrarPainel);
  $('btnEditar').addEventListener('click', () => {
    const f = $('formEntrar');
    f.apelido.value = vizinho.apelido; f.bairro.value = vizinho.bairro; f.raio.value = String(vizinho.raio); f.regras.checked = true;
    marcarCelula(vizinho.celula, 'atual');
    $('txtEntrar').textContent = 'Salvar alterações';
    $('btnCancelarEdicao').hidden = false;
    $('entrar').hidden = false; $('painel').hidden = true;
  });
  $('btnSair').addEventListener('click', async () => {
    if (!confirm('Sair da rede do bairro? Seus dados de participação serão apagados.')) return;
    try {
      if (meuAlerta?.status === 'ativo' && pet) await encerrarAlerta(pet.id);
      await sairDaRede(Object.keys(ajudantes).filter((p) => (ajudantes[p] || []).some((a) => souEu(a.uid))));
      vizinho = null; mostrarEntrar();
    } catch (err) { alert('Não foi possível sair: ' + err.message); }
  });
  $('chkNotif').addEventListener('change', async (ev) => {
    let ligar = ev.target.checked;
    if (ligar && 'Notification' in window && Notification.permission === 'default') ligar = (await Notification.requestPermission()) === 'granted';
    try { localStorage.setItem('bz-notif', ligar ? '1' : '0'); } catch { /* ok */ }
    ev.target.checked = ligar;
  });
  $('chkAuto').addEventListener('change', async (ev) => {
    try { vizinho = await salvarVizinho({ ...vizinho, autoPublicar: ev.target.checked }); } catch (err) { ev.target.checked = !ev.target.checked; alert(err.message); }
  });

  function mostrarEntrar() {
    $('txtEntrar').textContent = 'Entrar na rede';
    $('btnCancelarEdicao').hidden = true;
    $('entrar').hidden = false; $('painel').hidden = true;
    if (opcoes.area && !celulaEscolhida) marcarCelula(celulaDe(opcoes.area.lat, opcoes.area.lng), 'área segura da coleira');
    pararTudo();
  }

  function mostrarEu() {
    if (!vizinho) return;
    const uid = meuUidSelos(), info = uid ? selos[uid] : null;
    if (uid) pedirSelos([uid]);
    const selo = info?.principal
      ? `<br>${seloChip(info)} <span class="bz-selo-conta">${info.familias} ${info.familias === 1 ? 'família ajudada' : 'famílias ajudadas'}</span>`
      : '';
    $('euTexto').innerHTML = `<b>${esc(vizinho.apelido)}</b>, ${esc(vizinho.bairro)}<br>Alertas num raio de ${vizinho.raio} km da sua região.${selo}`;
  }

  function pararTudo() {
    pararAlertas?.(); pararAlertas = null;
    Object.values(pararAjud).forEach((f) => f?.()); Object.keys(pararAjud).forEach((k) => delete pararAjud[k]);
  }

  function mostrarPainel() {
    $('entrar').hidden = true; $('painel').hidden = false;
    mostrarEu();
    $('chkNotif').checked = notifLigada();
    $('convidar').href = 'https://wa.me/?text=' + encodeURIComponent(
      `Entrei na rede de alerta de pets do bairro ${vizinho.bairro}: quando um pet some, os vizinhos são avisados e ajudam a procurar. Ninguém vê onde você mora. Participe: ${new URL('bairro.html', location.href).href}`);
    $('linhaAuto').hidden = !pet;
    $('chkAuto').checked = !!vizinho.autoPublicar;
    criarMapa();
    pararTudo();
    conhecidos = null;
    pararAlertas = ouvirAlertasPerto(vizinho.celula, (r) => { ativos = r.ativos; recuperados = r.recuperados; aoMudarAlertas(); });
    if (pet && !pararMeu) {
      carregarDei();
      pararMeu = ouvirMeuAlerta(pet.id, (a) => { meuAlerta = a; renderMeu(); });
      pararAvist = ouvirAvistamentos(pet.id, (l) => { meusAvist = l; renderMeu(); desenharMapa(); });
    }
    renderMeu();
  }

  // ---------------------------------------------------------------- mapa
  function criarMapa() {
    const c = centroCelula(vizinho.celula);
    if (!mapa) {
      mapa = L.map($('mapa'), { zoomControl: true, scrollWheelZoom: false }).setView([c.lat, c.lng], vizinho.raio >= 3 ? 13 : 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(mapa);
      camada = L.layerGroup().addTo(mapa);
      camadaEu = L.layerGroup().addTo(mapa);
      new ResizeObserver(() => mapa.invalidateSize()).observe($('mapa'));
    } else mapa.setView([c.lat, c.lng], vizinho.raio >= 3 ? 13 : 14);
    camadaEu.clearLayers();
    L.circle([c.lat, c.lng], { radius: vizinho.raio * 1000, color: '#262b2e', weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(camadaEu);
  }
  function desenharMapa() {
    if (!mapa) return;
    camada.clearLayers();
    visiveis().forEach((a) => {
      const c = centroCelula(a.celula);
      const meu = pet && a.pet === pet.id;
      L.circle([c.lat, c.lng], { radius: RAIO_AREA_M, color: meu ? '#7a1712' : '#b3261e', weight: 1.5, fillOpacity: 0.12 })
        .bindPopup(`<b>${esc(a.nome)}</b><br>Área aproximada (~1 km)<br>${esc(a.bairro)}, perdido ${quando(a.desde)}`).addTo(camada);
    });
    // avistamentos do MEU pet: ponto exato, só o tutor vê
    if (pet && meuAlerta?.status === 'ativo') {
      avistAtuais().forEach((v) => {
        L.marker([v.lat, v.lng], { icon: L.divIcon({ className: '', html: '<div class="mk-achado novo"></div>', iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -9] }) })
          .bindPopup(`<b>${esc(v.apelido)} viu ${esc(pet.nome())}</b><br>${quando(v.em)}${v.nota ? '<br>' + esc(v.nota) : ''}<br><i>Só você vê este ponto.</i><br><a target="_blank" rel="noopener" href="${linkRota(v.lat, v.lng)}">Traçar rota</a>`)
          .addTo(camada);
      });
    }
  }

  // ---------------------------------------------------------------- alertas perto
  function visiveis() {
    const eu = centroCelula(vizinho.celula);
    return ativos.filter((a) => (pet && a.pet === pet.id) || distanciaKm(eu, centroCelula(a.celula)) <= vizinho.raio + 0.8);
  }
  function aoMudarAlertas() {
    const lista = visiveis();
    // ajudantes de cada alerta visível
    lista.forEach((a) => {
      if (!pararAjud[a.pet]) pararAjud[a.pet] = ouvirAjudantes(a.pet, (l) => { ajudantes[a.pet] = l; renderLista(); if (pet && a.pet === pet.id) renderMeu(); });
    });
    // avisa só os alertas novos (não o do próprio pet)
    const ids = new Set(lista.map((a) => a.pet + '|' + (a.desde?.getTime() || '')));
    if (conhecidos) {
      lista.filter((a) => !conhecidos.has(a.pet + '|' + (a.desde?.getTime() || '')) && !(pet && a.pet === pet.id)).forEach((a) => {
        const t = `Pet perdido perto de você: ${a.nome} (${a.bairro}). Abra a rede do bairro para ajudar.`;
        opcoes.avisar?.(t);
        if (notifLigada() && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
          try { new Notification('Rede do bairro', { body: t }); } catch { /* ok */ }
        }
      });
    }
    conhecidos = ids;
    const outros = lista.filter((a) => !(pet && a.pet === pet.id)).length;
    opcoes.aoContar?.(outros);
    $('numAtivos').textContent = lista.length;
    $('numVoltaram').textContent = recuperados.length;
    $('resumo').textContent = lista.length
      ? `${lista.length} ${lista.length === 1 ? 'pet perdido' : 'pets perdidos'} num raio de ${vizinho.raio} km. Os círculos mostram só a área aproximada.`
      : `Nenhum pet perdido num raio de ${vizinho.raio} km.`;
    renderLista();
    desenharMapa();
  }

  const ajudAtuais = (a) => (ajudantes[a.pet] || []).filter((x) => !a.desde || !x.em || x.em >= a.desde);
  function renderLista() {
    const lista = visiveis();
    const eu = centroCelula(vizinho.celula);
    const box = $('lista');
    // guarda o rascunho do "vi este pet"
    const rascunho = box.querySelector('textarea[name="nota"]')?.value || '';
    box.innerHTML = lista.length ? '' : '<p class="dica bz-vazio">Quando um vizinho ativar o modo perdido, o alerta aparece aqui.</p>';
    lista.forEach((a) => {
      const meu = pet && a.pet === pet.id;
      const ajud = ajudAtuais(a);
      const euAjudo = ajud.some((x) => souEu(x.uid));
      pedirSelos(ajud.slice(0, 4).map((x) => x.uid));
      const km = distanciaKm(eu, centroCelula(a.celula));
      const foto = fotoSegura(a.foto);
      const el = document.createElement('article');
      el.className = 'bz-alerta' + (meu ? ' meu' : '');
      el.innerHTML = `
        <div class="bz-alerta-topo">
          ${foto ? `<img class="bz-foto" alt="Foto de ${esc(a.nome)}">` : `<span class="bz-foto avatar" aria-hidden="true">${esc((a.nome || '?').charAt(0).toUpperCase())}</span>`}
          <div>
            <strong>${esc(a.nome)} ${meu ? '<span class="chip">Seu pet</span>' : ''}</strong>
            <small>Perdido ${quando(a.desde)} no bairro ${esc(a.bairro)}, a ${km < 1 ? 'menos de 1 km' : `cerca de ${Math.round(km)} km`} de você</small>
          </div>
        </div>
        ${a.descricao ? `<p class="bz-desc">${esc(a.descricao)}</p>` : ''}
        <p class="bz-ajudando">${ajud.length ? `${ajud.length} ${ajud.length === 1 ? 'vizinho procurando' : 'vizinhos procurando'}: ${ajud.slice(0, 4).map((x) => comSelo(x.uid, x.apelido)).join(', ')}${ajud.length > 4 ? '...' : ''}` : 'Ninguém procurando ainda'}</p>
        ${meu ? '' : `
        <div class="bz-acoes">
          <button type="button" class="pilula ${euAjudo ? 'ok-btn' : 'leve'}" data-acao="procurar"><svg aria-hidden="true"><use href="#i-vizinhos"/></svg>${euAjudo ? '✓ Estou procurando' : 'Estou procurando'}</button>
          <button type="button" class="pilula leve" data-acao="vi"><svg aria-hidden="true"><use href="#i-olho"/></svg>Vi este pet</button>
          <a class="pilula primario" data-acao="comigo" target="_blank" rel="noopener"><svg aria-hidden="true"><use href="#i-check"/></svg>Está comigo</a>
          <a class="pilula leve" data-acao="compartilhar" target="_blank" rel="noopener"><svg aria-hidden="true"><use href="#i-zap"/></svg>Compartilhar alerta</a>
        </div>
        <form class="bz-vi" data-acao="formVi" ${viAberto === a.pet ? '' : 'hidden'}>
          <label class="campo">Onde e como estava? (opcional)<textarea name="nota" rows="2" maxlength="200" placeholder="Ex.: correndo perto da praça, sentido avenida"></textarea></label>
          <p class="dica">Enviamos a sua localização de agora. Só o tutor vê o ponto exato.</p>
          <div class="bz-linha"><button class="pilula primario" type="submit"><svg aria-hidden="true"><use href="#i-mapa"/></svg>Enviar onde vi</button>
          <button class="pilula leve" type="button" data-acao="fecharVi">Cancelar</button></div>
          <p class="qr-status" data-acao="statusVi" role="status"></p>
        </form>
        <button type="button" class="bz-denunciar" data-acao="denunciar">Denunciar este alerta</button>`}`;
      if (foto) el.querySelector('img.bz-foto').src = foto;
      if (!meu) {
        const comigo = el.querySelector('[data-acao="comigo"]');
        const linkQR = urlPaginaQR(a.pet);
        if (a.simulado) { comigo.removeAttribute('href'); comigo.classList.add('desativado'); comigo.title = 'Pet fictício da simulação'; }
        else comigo.href = linkQR;
        el.querySelector('[data-acao="compartilhar"]').href = 'https://wa.me/?text=' + encodeURIComponent(
          `${a.nome} está perdido na região do ${a.bairro}. ${a.descricao ? a.descricao + ' ' : ''}Se encontrar, avise o tutor por aqui: ${linkQR}`);
        el.querySelector('[data-acao="procurar"]').addEventListener('click', async () => {
          try { await estouProcurando(a.pet, vizinho.apelido, !euAjudo); } catch (err) { alert(err.message); }
        });
        el.querySelector('[data-acao="vi"]').addEventListener('click', () => { viAberto = viAberto === a.pet ? null : a.pet; renderLista(); });
        el.querySelector('[data-acao="fecharVi"]').addEventListener('click', () => { viAberto = null; renderLista(); });
        if (viAberto === a.pet) el.querySelector('textarea[name="nota"]').value = rascunho;
        el.querySelector('[data-acao="formVi"]').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const st = el.querySelector('[data-acao="statusVi"]');
          try {
            st.textContent = 'Pegando a sua localização...'; st.className = 'qr-status';
            const p = await pegarLocal();
            await enviarAvistamento(a.pet, { apelido: vizinho.apelido, lat: p.lat, lng: p.lng, precisao: p.precisao, nota: ev.target.nota.value.trim() });
            viAberto = null;
            renderLista();
            opcoes.avisar?.(`Obrigado! O tutor de ${a.nome} recebeu onde você viu.`, true);
          } catch (err) { st.textContent = err.message; st.className = 'qr-status erro'; }
        });
        el.querySelector('[data-acao="denunciar"]').addEventListener('click', async () => {
          const motivo = prompt('O que há de errado com este alerta? (ex.: pedido de dinheiro, alerta falso, dados de outra pessoa)');
          if (!motivo) return;
          try { await denunciar(a.pet, motivo); alert('Denúncia enviada. Obrigado por cuidar da rede.'); } catch (err) { alert(err.message); }
        });
      }
      box.append(el);
    });
  }

  // ---------------------------------------------------------------- alerta do meu pet (tutor)
  const avistAtuais = () => meusAvist.filter((v) => !meuAlerta?.desde || !v.em || v.em >= meuAlerta.desde);
  function renderMeu() {
    const box = $('meuAlerta');
    if (!pet || !vizinho) { box.hidden = true; return; }
    box.hidden = false;
    const ativo = meuAlerta?.status === 'ativo';
    const nome = esc(pet.nome());
    const rascunho = box.querySelector('textarea[name="descricao"]')?.value;
    if (meuAlerta && !pararAjud[pet.id]) pararAjud[pet.id] = ouvirAjudantes(pet.id, (l) => { ajudantes[pet.id] = l; renderMeu(); renderLista(); });
    const ajudMeu = meuAlerta ? ((ajudantes[pet.id] && ajudAtuais({ ...meuAlerta, pet: pet.id })) || []) : [];
    if (!ativo) {
      const perdido = pet.perdido();
      box.className = 'cartao bz-meu' + (perdido ? ' pedir' : '');
      box.innerHTML = `
        <h2>Alerta de ${nome} no bairro</h2>
        <p class="dica">${perdido
          ? `${nome} está no modo perdido. Avise os vizinhos num raio de até 3 km da sua região. Eles veem só a área aproximada, nunca o seu endereço.`
          : `Se ${nome} sumir, ative o modo perdido e publique aqui. ${vizinho.autoPublicar ? 'Está marcado para publicar sozinho.' : ''}`}</p>
        <label class="campo">Como reconhecer ${nome} (aparece para os vizinhos)
          <textarea name="descricao" rows="2" maxlength="200" placeholder="Ex.: porte médio, caramelo, coleira laranja. É medroso."></textarea>
        </label>
        <p class="dica">Não coloque endereço, valor do pet nem recompensa em dinheiro: isso atrai golpistas.</p>
        <button type="button" class="pilula perigo" data-bz="btnPublicar" ${perdido ? '' : 'disabled'}><svg aria-hidden="true"><use href="#i-megafone"/></svg>Publicar alerta no bairro</button>
        <p class="qr-status" data-bz="statusMeu" role="status"></p>
        ${!perdido && meuAlerta?.status === 'resolvido' ? blocoAgradecer(ajudMeu, avistAtuais(), `Quem ajudou a encontrar ${nome}`) : ''}`;
      ligarAgradecer(box);
      const ta = box.querySelector('textarea[name="descricao"]');
      ta.value = rascunho ?? pet.descricao?.() ?? '';
      box.querySelector('[data-bz="btnPublicar"]').addEventListener('click', () => publicarMeu(ta.value));
      return;
    }
    const ajud = (ajudantes[pet.id] && ajudAtuais({ ...meuAlerta, pet: pet.id })) || [];
    if (!pararAjud[pet.id]) pararAjud[pet.id] = ouvirAjudantes(pet.id, (l) => { ajudantes[pet.id] = l; renderMeu(); renderLista(); });
    const avs = avistAtuais();
    box.className = 'cartao bz-meu publicado';
    box.innerHTML = `
      <h2>Alerta de ${nome} publicado</h2>
      <p class="dica">Publicado ${quando(meuAlerta.desde)} no bairro ${esc(meuAlerta.bairro)}. Vizinhos num raio de até 3 km recebem.</p>
      <p class="bz-ajudando">${ajud.length ? `<b>${ajud.length}</b> ${ajud.length === 1 ? 'vizinho procurando' : 'vizinhos procurando'}: ${ajud.map((x) => comSelo(x.uid, x.apelido)).join(', ')}` : 'Aguardando vizinhos...'}</p>
      <h3>Avistamentos <small>(só você vê o ponto exato)</small></h3>
      <ul class="bz-avist">${avs.length ? avs.map((v, i) => `
        <li><div><b>${comSelo(v.autor, v.apelido)}</b> viu ${quando(v.em)}${v.precisao ? ` (precisão de ~${v.precisao} m)` : ''}${v.nota ? `<br><span>${esc(v.nota)}</span>` : ''}</div>
        <div class="bz-linha"><button type="button" class="pilula leve" data-ver="${i}"><svg aria-hidden="true"><use href="#i-mapa"/></svg>Ver no mapa</button>
        <a class="pilula leve" target="_blank" rel="noopener" href="${linkRota(v.lat, v.lng)}">Traçar rota</a></div></li>`).join('') : '<li class="vazio">Quando um vizinho disser onde viu, aparece aqui e no mapa.</li>'}</ul>
      ${blocoAgradecer(ajud, avs, 'Agradeça quem está ajudando')}
      <div class="bz-linha">
        <button type="button" class="pilula leve" data-bz="btnEncerrar"><svg aria-hidden="true"><use href="#i-check"/></svg>Encerrar alerta</button>
      </div>`;
    ligarAgradecer(box);
    box.querySelectorAll('[data-ver]').forEach((b) => b.addEventListener('click', () => {
      const v = avs[+b.dataset.ver];
      mapa?.flyTo([v.lat, v.lng], 17);
      $('mapa').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
    box.querySelector('[data-bz="btnEncerrar"]').addEventListener('click', async () => {
      try { await encerrarAlerta(pet.id); } catch (err) { alert(err.message); }
    });
  }

  // ---------------------------------------------------------------- agradecer (selos)
  // Uma linha por pessoa: quem procurou junto e quem disse onde viu. O tutor dá o reconhecimento;
  // as regras do Firestore conferem que a ajuda existe e que é dessa pessoa.
  function quemAjudou(ajud, avs) {
    const pessoas = new Map();
    ajud.forEach((x) => pessoas.set(x.uid, { uid: x.uid, apelido: x.apelido, origem: 'ajudante', origemId: x.uid, fez: 'procurou junto' }));
    avs.forEach((v) => {
      if (!v.autor || !v.id) return;
      const p = pessoas.get(v.autor);
      if (p) p.fez = 'procurou junto e disse onde viu';
      else pessoas.set(v.autor, { uid: v.autor, apelido: v.apelido, origem: 'avistamento', origemId: v.id, fez: 'disse onde viu' });
    });
    return [...pessoas.values()].filter((p) => !souEu(p.uid));
  }
  let pessoasAgradecer = [];
  function blocoAgradecer(ajud, avs, titulo) {
    pessoasAgradecer = quemAjudou(ajud, avs);
    if (!pessoasAgradecer.length) return '';
    pedirSelos(pessoasAgradecer.map((p) => p.uid));
    return `<h3>${esc(titulo)}</h3>
      <p class="dica">O agradecimento vira selo no perfil da pessoa (Olhar Atento, Guardião dos Animais...). Os outros vizinhos veem o selo ao lado do apelido.</p>
      <ul class="bz-agradecer">${pessoasAgradecer.map((p, i) => {
        const id = idReconhecimento(pet.id, p.origem, p.origemId), feito = dei.has(id);
        return `<li><div><b>${comSelo(p.uid, p.apelido, false)}</b><small>${esc(p.fez)}</small></div>
          ${feito
            ? `<span class="bz-linha"><span class="bz-agradecido"><svg aria-hidden="true"><use href="#i-check"/></svg>Agradecido</span><button type="button" class="link-botao" data-desagradecer="${i}">Desfazer</button></span>`
            : `<button type="button" class="pilula leve" data-agradecer="${i}"><svg aria-hidden="true"><use href="#i-coracao"/></svg>Agradecer</button>`}</li>`;
      }).join('')}</ul>`;
  }
  function ligarAgradecer(box) {
    box.querySelectorAll('[data-agradecer]').forEach((b) => b.addEventListener('click', async () => {
      const p = pessoasAgradecer[+b.dataset.agradecer];
      b.disabled = true;
      try {
        const id = await reconhecer({ pet: pet.id, origem: p.origem, origemId: p.origemId, para: p.uid, tipo: 'ajudou' });
        dei.add(id);
        opcoes.avisar?.(`Obrigado enviado para ${p.apelido}.`);
      } catch (err) { console.error(err); alert('Não foi possível agradecer: ' + err.message); }
      renderMeu();
    }));
    box.querySelectorAll('[data-desagradecer]').forEach((b) => b.addEventListener('click', async () => {
      const p = pessoasAgradecer[+b.dataset.desagradecer];
      const id = idReconhecimento(pet.id, p.origem, p.origemId);
      try { await retirarReconhecimento(id, p.uid); dei.delete(id); } catch (err) { alert('Não foi possível desfazer: ' + err.message); }
      renderMeu();
    }));
  }

  async function publicarMeu(descricao) {
    const st = raiz.querySelector('[data-bz="statusMeu"]');
    try {
      if (st) { st.textContent = 'Publicando...'; st.className = 'qr-status'; }
      await publicarAlerta({ pet: pet.id, nome: pet.nome(), foto: fotoSegura(pet.foto()), descricao: descricao ?? pet.descricao?.() ?? '', vizinho });
      pet.salvarDescricao?.(descricao);
    } catch (err) { console.error(err); if (st) { st.textContent = 'Não foi possível publicar: ' + err.message; st.className = 'qr-status erro'; } }
  }

  // ---------------------------------------------------------------- início
  try { vizinho = await lerVizinho(); } catch (err) { console.error(err); }
  if (vizinho) mostrarPainel(); else mostrarEntrar();

  return {
    // modo perdido ligado/desligado no painel: publica (se o tutor quiser) ou encerra o alerta
    async sincronizarPerdido(perdido) {
      if (!pet) return;
      if (perdido && vizinho?.autoPublicar) await publicarMeu();
      else if (!perdido && meuAlerta?.status === 'ativo') await encerrarAlerta(pet.id);
      renderMeu();
    },
    atualizarPet() { renderMeu(); },
    simularVizinhos() {
      if (!pet || !emSimulacao()) return false;
      return simularVizinhos(pet.id, pet.posicao());
    },
    membro: () => !!vizinho,
    alertaAtivo: () => meuAlerta?.status === 'ativo'
  };
}
