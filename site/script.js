import { firebaseConfig, PET_ID, PET_NOME, AREA_PADRAO, SEM_SINAL_SEGUNDOS } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const FIREBASE_VERSAO = '10.12.2';
const configurado = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'COLE_AQUI';

// ============================================================ estado da página
let area = carregarAreaLocal() || { ...AREA_PADRAO };   // área salva (a que vale para os alertas)
let areaEditada = null;                                   // rascunho enquanto o tutor edita
let pilhaDesfazer = [];                                   // versões anteriores do rascunho
let movendoCasa = false;
let ultimoEstado = null;
let anterior = { fora: null, coleiraNoPet: null };
let alertasLocais = [];
const historicoBpm = [];
const trilha = [];
let db = null, fs = null;

$('nomePet').textContent = PET_NOME;
document.title = `${PET_NOME} | Coleira inteligente`;

const areaAtual = () => areaEditada || area;
const mesmaArea = (a, b) => a.lat === b.lat && a.lng === b.lng && a.raio === b.raio;
const temPendencia = () => !mesmaArea(areaAtual(), area);

// ============================================================ mapa
const map = L.map('map', { zoomControl: true }).setView([area.lat, area.lng], 17);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const circuloArea = L.circle([area.lat, area.lng], {
  color: '#4747a8', weight: 3, dashArray: '8 8', fillColor: '#4747a8', fillOpacity: 0.12, radius: area.raio
}).addTo(map);

const iconeCasa = (editando) => L.divIcon({
  className: '',
  html: `<div class="mk-casa ${editando ? 'editando' : ''}"><svg><use href="#i-casa"/></svg></div>`,
  iconSize: [46, 46], iconAnchor: [23, 46], popupAnchor: [0, -44]
});
const marcadorCasa = L.marker([area.lat, area.lng], { icon: iconeCasa(false), draggable: true, keyboard: false })
  .addTo(map).bindPopup('<b>Casa</b>');
marcadorCasa.dragging.disable();

const iconePet = (fora) => L.divIcon({
  className: '',
  html: `<div class="mk-pet ${fora ? 'fora' : ''}"><svg viewBox="0 0 120 120"><use href="#i-cao"/></svg></div>`,
  iconSize: [52, 52], iconAnchor: [26, 26], popupAnchor: [0, -26]
});
const marcadorPet = L.marker([area.lat, area.lng], { icon: iconePet(false), zIndexOffset: 1000 }).addTo(map);
const camadaPatas = L.layerGroup().addTo(map);

function desenharArea() {
  const a = areaAtual();
  circuloArea.setLatLng([a.lat, a.lng]).setRadius(a.raio);
  marcadorCasa.setLatLng([a.lat, a.lng]);
  $('raio').value = a.raio;
  $('raioValor').textContent = a.raio + ' m';
  const r = $('raio');
  r.style.setProperty('--pct', ((a.raio - r.min) / (r.max - r.min)) * 100 + '%');
  atualizarControlesArea();
  if (ultimoEstado) renderEstado(ultimoEstado, false);
}

// ============================================================ utilitários
const fmtHora = (d) => d ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
function haQuanto(d) {
  if (!d) return '-';
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  return fmtHora(d);
}
const linkMapa = (lat, lng) => `https://maps.google.com/?q=${lat},${lng}`;
const linkZap = (texto) => `https://wa.me/?text=${encodeURIComponent(texto)}`;
const paraData = (v) => !v ? null : (v.toDate ? v.toDate() : new Date(v));
const usar = (el, id) => el.setAttribute('href', '#' + id);

function carregarAreaLocal() {
  try { return JSON.parse(localStorage.getItem('coleira-area')); } catch { return null; }
}
function salvarAreaLocal(a) {
  try { localStorage.setItem('coleira-area', JSON.stringify(a)); } catch { /* sem armazenamento */ }
}

// ============================================================ aviso flutuante com "Desfazer"
let timerAviso = null, acaoAviso = null;
function mostrarAviso(texto, rotuloAcao, acao, ms = 8000) {
  $('avisoTexto').textContent = texto;
  $('avisoAcao').hidden = !acao;
  $('avisoAcao').textContent = rotuloAcao || '';
  acaoAviso = acao;
  $('aviso').hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => { $('aviso').hidden = true; acaoAviso = null; }, ms);
}
$('avisoAcao').addEventListener('click', () => {
  const fn = acaoAviso;
  $('aviso').hidden = true; acaoAviso = null; clearTimeout(timerAviso);
  if (fn) fn();
});

// ============================================================ painel
function renderEstado(e, novo = true) {
  ultimoEstado = e;
  const a = areaAtual();
  const temPosicao = e.gpsFix !== false && e.lat && e.lng;
  const dist = temPosicao ? Math.round(map.distance([a.lat, a.lng], [e.lat, e.lng])) : null;
  const fora = dist != null && dist > a.raio;

  // distância + régua (meio da régua = limite da área)
  $('distancia').textContent = dist != null ? `${dist} m` : 'sem GPS';
  $('distanciaLegenda').textContent = `da casa · limite ${a.raio} m`;
  $('reguaPreench').style.width = dist != null ? Math.min(100, (dist / (a.raio * 2)) * 100) + '%' : '0';

  // batimentos
  const bpm = e.coleiraNoPet ? (e.batimentos || 0) : 0;
  $('batimentos').textContent = !e.coleiraNoPet ? '--' : bpm || '...';
  $('bpmUnidade').textContent = !e.coleiraNoPet ? 'sem leitura' : bpm ? 'bpm' : 'medindo';
  $('cartaoBpm').classList.toggle('ativo', bpm > 0);
  if (bpm > 0) $('cartaoBpm').style.setProperty('--batida', (60 / bpm).toFixed(2) + 's');
  if (novo) { historicoBpm.push(bpm || null); if (historicoBpm.length > 60) historicoBpm.shift(); }
  desenharBpm();

  // coleira
  $('coleira').textContent = e.coleiraNoPet ? 'No pet' : 'Removida';
  $('coleira').className = 'sinal-valor pequeno ' + (e.coleiraNoPet ? 'ok' : 'ruim');
  $('cartaoColeira').classList.toggle('removida', !e.coleiraNoPet);
  usar($('iconeColeira'), e.coleiraNoPet ? 'i-check' : 'i-x');

  // bateria em forma de osso
  const bat = Math.max(0, Math.min(100, e.bateria ?? 0));
  $('bateria').textContent = e.bateria != null ? `${bat}%` : '-';
  $('bateria').className = bat <= 15 ? 'ruim' : '';
  $('ossoPreench').setAttribute('width', (120 * bat) / 100);
  $('ossoPreench').style.fill = bat <= 15 ? 'var(--vermelho)' : bat <= 35 ? 'var(--ambar)' : 'var(--menta)';

  // gps
  const sats = e.gpsFix === false ? 0 : e.satelites || 0;
  const nivel = sats >= 9 ? 4 : sats >= 6 ? 3 : sats >= 4 ? 2 : sats >= 1 ? 1 : 0;
  [...$('barrasGps').children].forEach((b, i) => b.classList.toggle('on', i < nivel));
  $('gps').textContent = e.gpsFix === false ? 'Procurando satélites' : `${sats || '?'} satélites`;
  $('gps').className = 'sinal-valor pequeno ' + (e.gpsFix === false ? 'atencao' : '');
  $('latitude').textContent = temPosicao ? e.lat.toFixed(6) : '-';
  $('longitude').textContent = temPosicao ? e.lng.toFixed(6) : '-';
  $('atualizado').textContent = haQuanto(e.atualizadoEm);

  // mapa
  if (temPosicao) {
    marcadorPet.setLatLng([e.lat, e.lng]).setIcon(iconePet(fora));
    marcadorPet.bindPopup(`<b>${PET_NOME}</b> ${fora ? 'está FORA da área' : 'está dentro da área'}`);
    if (novo) adicionarPegada(e.lat, e.lng);
  }

  atualizarStatus(e, fora, dist);
  if (novo) verificarMudancas(e, fora);
}

// rastro de patinhas apontando para onde o pet andou
function adicionarPegada(lat, lng) {
  const ult = trilha[trilha.length - 1];
  if (ult && map.distance([ult.lat, ult.lng], [lat, lng]) < 3) return;
  let rumo = 0;
  if (ult) {
    const dy = lat - ult.lat, dx = (lng - ult.lng) * Math.cos((lat * Math.PI) / 180);
    rumo = (Math.atan2(dx, dy) * 180) / Math.PI;
  }
  trilha.push({ lat, lng, rumo });
  if (trilha.length > 30) trilha.shift();
  camadaPatas.clearLayers();
  trilha.slice(0, -1).forEach((p, i, lista) => {
    const opac = 0.25 + 0.65 * ((i + 1) / lista.length);
    const lado = i % 2 ? 4 : -4;
    L.marker([p.lat, p.lng], {
      interactive: false, keyboard: false,
      icon: L.divIcon({
        className: 'mk-pata', iconSize: [16, 16], iconAnchor: [8, 8],
        html: `<svg style="opacity:${opac};transform:rotate(${p.rumo}deg) translateX(${lado}px)"><use href="#i-pata"/></svg>`
      })
    }).addTo(camadaPatas);
  });
}

const semSinal = (e) => e?.atualizadoEm && (Date.now() - e.atualizadoEm.getTime()) / 1000 > SEM_SINAL_SEGUNDOS;

function atualizarStatus(e, fora, dist) {
  let estado, etiqueta, texto;
  if (semSinal(e)) {
    estado = 'sem-sinal'; etiqueta = 'Sem sinal';
    texto = `A coleira não envia dados desde ${fmtHora(e.atualizadoEm)}.`;
  } else if (fora) {
    estado = 'fora'; etiqueta = 'Fora da área';
    texto = `${PET_NOME} saiu da área segura! Veja no mapa onde ele está.`;
  } else if (dist == null) {
    estado = 'aguardando'; etiqueta = 'Procurando GPS';
    texto = 'A coleira está ligada e aguardando sinal de GPS.';
  } else {
    estado = 'dentro'; etiqueta = 'Em casa';
    texto = `${PET_NOME} está dentro da área segura. Tudo tranquilo por aqui.`;
  }
  document.body.dataset.estado = estado;
  $('etiquetaEstado').textContent = etiqueta;
  $('status').textContent = texto;

  const problema = fora ? 'fora' : !e.coleiraNoPet ? 'coleira' : null;
  $('banner').hidden = !problema;
  if (problema) {
    const msg = problema === 'fora'
      ? `${PET_NOME} saiu da área segura e está a ${dist} m de casa.`
      : `A coleira de ${PET_NOME} foi removida.`;
    $('banner').classList.toggle('coleira', problema === 'coleira');
    usar($('bannerIcone'), problema === 'fora' ? 'i-corre' : 'i-tag');
    $('bannerTitulo').textContent = problema === 'fora' ? 'Pet fora de casa!' : 'Coleira removida!';
    $('bannerTexto').textContent = msg;
    $('bannerMapa').href = linkMapa(e.lat, e.lng);
    $('bannerZap').href = linkZap(`${msg} Última localização: ${linkMapa(e.lat, e.lng)}`);
  }
}

function desenharBpm() {
  const cv = $('graficoBpm'), ctx = cv.getContext('2d');
  const dpr = devicePixelRatio || 1;
  const w = (cv.width = Math.max(1, cv.clientWidth * dpr)), h = (cv.height = 44 * dpr);
  ctx.clearRect(0, 0, w, h);
  const vals = historicoBpm.filter(Boolean);
  if (vals.length < 2) return;
  const min = Math.min(...vals) - 8, max = Math.max(...vals) + 8;
  const ponto = (v, i) => [(i / 59) * w, h - ((v - min) / (max - min)) * (h - 8) - 4];
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(239,64,87,0.28)'); grad.addColorStop(1, 'rgba(239,64,87,0)');
  // segmentos contínuos (sem leitura = falha na linha)
  let seg = [];
  const fechar = () => {
    if (seg.length > 1) {
      ctx.beginPath(); seg.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.lineTo(seg[seg.length - 1][0], h); ctx.lineTo(seg[0][0], h); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); seg.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = '#ef4057'; ctx.lineWidth = 2.5 * dpr; ctx.lineJoin = 'round'; ctx.stroke();
    }
    seg = [];
  };
  historicoBpm.forEach((v, i) => (v ? seg.push(ponto(v, i)) : fechar()));
  fechar();
}

// ============================================================ alertas
const TIPO = {
  saiu_area: ['grave', 'i-corre'], coleira_removida: ['grave', 'i-tag'], bateria_baixa: ['aviso', 'i-bateria'],
  voltou_area: ['bom', 'i-casa'], coleira_colocada: ['bom', 'i-check']
};
const NS = 'http://www.w3.org/2000/svg';
function iconeSvg(id) {
  const s = document.createElementNS(NS, 'svg'), u = document.createElementNS(NS, 'use');
  u.setAttribute('href', '#' + id); s.append(u); return s;
}

function renderAlertas(lista) {
  const ul = $('alertas');
  ul.replaceChildren();
  if (!lista.length) {
    const li = document.createElement('li'); li.className = 'vazio';
    li.append(iconeSvg('i-pata'), document.createTextNode('Nenhum alerta. Seu pet está tranquilo.'));
    ul.append(li); return;
  }
  lista.forEach((a, i) => {
    const [classe, icone] = TIPO[a.tipo] || ['', 'i-sino'];
    const li = document.createElement('li');
    li.className = classe;
    li.style.animationDelay = Math.min(i, 6) * 40 + 'ms';
    const ic = document.createElement('span'); ic.className = 'icone'; ic.append(iconeSvg(icone));
    const msg = document.createElement('span'); msg.className = 'msg'; msg.textContent = a.mensagem;
    if (a.lat && a.lng) {
      const link = document.createElement('a');
      link.href = linkMapa(a.lat, a.lng); link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'ver no mapa';
      msg.append(' ', link);
    }
    const t = document.createElement('time');
    t.textContent = a.data ? a.data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
    li.append(ic, msg, t);
    ul.append(li);
  });
}

function verificarMudancas(e, fora) {
  if (anterior.fora === false && fora) avisar(`${PET_NOME} saiu da área segura!`);
  if (anterior.coleiraNoPet === true && !e.coleiraNoPet) avisar(`A coleira de ${PET_NOME} foi removida!`);
  anterior = { fora, coleiraNoPet: e.coleiraNoPet };
}

let audio = null;
function avisar(texto) {
  try {
    audio = audio || new AudioContext();
    [0, 0.18].forEach((t) => {           // "au-au": dois bipes
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'triangle'; o.frequency.value = 660;
      g.gain.setValueAtTime(0.18, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + t + 0.15);
      o.connect(g).connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.16);
    });
  } catch { /* sem som */ }
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Coleira inteligente', { body: texto });
  }
}

$('btnNotificar').addEventListener('click', async () => {
  if (!('Notification' in window)) { $('btnNotificar').textContent = 'Navegador sem notificações'; return; }
  const p = await Notification.requestPermission();
  $('btnNotificar').textContent = p === 'granted' ? 'Notificações ativas' : 'Notificações bloqueadas';
  try { audio = audio || new AudioContext(); } catch { /* ok */ }
});

// ============================================================ editar a área segura (com desfazer)
function editar(nova) {
  const atual = areaAtual();
  if (mesmaArea(nova, atual)) return;
  pilhaDesfazer.push({ ...atual });
  if (pilhaDesfazer.length > 50) pilhaDesfazer.shift();
  areaEditada = nova;
  desenharArea();
}

function desfazer() {
  if (!pilhaDesfazer.length) return;
  areaEditada = pilhaDesfazer.pop();
  if (!pilhaDesfazer.length && mesmaArea(areaEditada, area)) areaEditada = null;
  desenharArea();
  mostrarAviso('Alteração desfeita', null, null, 2500);
}

function cancelarEdicao() {
  pilhaDesfazer = [];
  areaEditada = null;
  definirMovendo(false);
  desenharArea();
  mostrarAviso('Edição cancelada. A área salva foi mantida.', null, null, 3000);
}

function definirMovendo(ligado) {
  movendoCasa = ligado;
  $('btnMoverCasa').classList.toggle('ativo', ligado);
  $('btnMoverCasa').querySelector('span').textContent = ligado ? 'Pronto' : 'Mover casa';
  $('map').classList.toggle('movendo', ligado);
  $('dicaMapa').hidden = !ligado;
  marcadorCasa.setIcon(iconeCasa(ligado));
  ligado ? marcadorCasa.dragging.enable() : marcadorCasa.dragging.disable();
  ligado ? marcadorCasa.closePopup() : null;
  atualizarControlesArea();
}

function atualizarControlesArea() {
  const n = pilhaDesfazer.length, pend = temPendencia();
  $('btnDesfazer').disabled = !n;
  $('contDesfazer').hidden = n < 2;
  $('contDesfazer').textContent = n;
  $('btnCancelar').disabled = !pend && !movendoCasa;
  $('btnSalvarArea').disabled = !pend;
  const dica = $('dicaArea');
  if (pend) {
    dica.className = 'dica pendente';
    dica.textContent = 'Alterações ainda não salvas. Os alertas continuam usando a área anterior até você salvar.';
  } else if (!dica.classList.contains('salvo')) {
    dica.className = 'dica';
    dica.textContent = 'A área azul é onde o pet pode ficar sem gerar alerta.';
  }
}

$('btnMoverCasa').addEventListener('click', () => definirMovendo(!movendoCasa));
$('btnDesfazer').addEventListener('click', desfazer);
$('btnCancelar').addEventListener('click', cancelarEdicao);

map.on('click', (ev) => {
  if (!movendoCasa) return;
  editar({ ...areaAtual(), lat: +ev.latlng.lat.toFixed(6), lng: +ev.latlng.lng.toFixed(6) });
});
marcadorCasa.on('drag', (ev) => circuloArea.setLatLng(ev.latlng));
marcadorCasa.on('dragend', (ev) => {
  const p = ev.target.getLatLng();
  editar({ ...areaAtual(), lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
});

// o raio vira um passo de desfazer por arraste (não um por pixel)
let arrastandoRaio = false;
$('raio').addEventListener('input', () => {
  const raio = +$('raio').value;
  if (!arrastandoRaio) { pilhaDesfazer.push({ ...areaAtual() }); arrastandoRaio = true; }
  areaEditada = { ...areaAtual(), raio };
  desenharArea();
});
$('raio').addEventListener('change', () => {
  arrastandoRaio = false;
  const topo = pilhaDesfazer[pilhaDesfazer.length - 1];
  if (topo && mesmaArea(topo, areaAtual())) pilhaDesfazer.pop();   // voltou ao mesmo valor
  if (!pilhaDesfazer.length && mesmaArea(areaAtual(), area)) areaEditada = null;
  desenharArea();
});

document.addEventListener('keydown', (ev) => {
  const alvo = ev.target.tagName;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey && alvo !== 'TEXTAREA' && !(alvo === 'INPUT' && ev.target.type === 'text')) {
    if (pilhaDesfazer.length) { ev.preventDefault(); desfazer(); }
  }
  if (ev.key === 'Escape' && movendoCasa) definirMovendo(false);
});

async function gravarArea(a) {
  if (db) await fs.setDoc(fs.doc(db, 'config', 'area'), { ...a, atualizadoEm: fs.serverTimestamp() });
  else salvarAreaLocal(a);
}

$('btnSalvarArea').addEventListener('click', async () => {
  if (!temPendencia()) return;
  const nova = { ...areaAtual() }, antiga = { ...area };
  $('btnSalvarArea').disabled = true;
  try {
    await gravarArea(nova);
    area = nova; areaEditada = null; pilhaDesfazer = [];
    definirMovendo(false);
    const dica = $('dicaArea');
    dica.className = 'dica salvo';
    dica.textContent = db ? 'Área salva. A coleira passa a usar a nova área em até 1 minuto.' : 'Área salva neste navegador (modo simulação).';
    setTimeout(() => { dica.classList.remove('salvo'); atualizarControlesArea(); }, 6000);
    desenharArea();
    mostrarAviso('Área segura salva', 'Desfazer', async () => {
      try {
        await gravarArea(antiga);
        area = antiga; areaEditada = null; pilhaDesfazer = [];
        desenharArea();
        mostrarAviso('A área anterior foi restaurada', null, null, 3000);
      } catch (err) { mostrarAviso('Não foi possível desfazer: ' + err.message, null, null, 5000); }
    });
  } catch (err) {
    console.error(err);
    $('dicaArea').className = 'dica pendente';
    $('dicaArea').textContent = 'Não foi possível salvar: ' + err.message;
    atualizarControlesArea();
  }
});

// ============================================================ simulador
// Faz o papel da coleira: sem Firebase atualiza só a página;
// com Firebase grava em pets/{PET_ID} e alertas, como o firmware.
const sim = { lat: area.lat + 0.00005, lng: area.lng - 0.00015, coleiraNoPet: true, bateria: 86, dentro: true, rota: null };
let ultimoEnvioSim = 0;

function rotaFuga() {
  // sai de casa, vai até ~70 m além do limite da área e volta
  const pts = [], n = 40, alcance = (area.raio + 70) / 111320;
  for (let i = 0; i <= n; i++) {
    const t = i / n, ida = t < 0.5 ? t * 2 : (1 - t) * 2;
    pts.push([area.lat - alcance * ida + 0.00008 * Math.sin(i), area.lng - alcance * 0.7 * ida * ida + 0.00005 * Math.cos(i)]);
  }
  return pts;
}

async function passoSimulador(forcar = false) {
  if (sim.rota) {
    [sim.lat, sim.lng] = sim.rota.shift();
    if (!sim.rota.length) { sim.rota = null; marcarPasseio(false); }
  }
  const dist = map.distance([area.lat, area.lng], [sim.lat, sim.lng]);
  const dentro = dist <= area.raio;
  const base = dentro ? 92 : 138;
  const estado = {
    nome: PET_NOME, lat: sim.lat, lng: sim.lng, gpsFix: true, satelites: 8,
    batimentos: sim.coleiraNoPet ? Math.round(base + (Math.random() - 0.5) * 10) : 0,
    coleiraNoPet: sim.coleiraNoPet, dentroArea: dentro, distancia: Math.round(dist),
    bateria: Math.round(sim.bateria), atualizadoEm: new Date()
  };
  sim.bateria = Math.max(5, sim.bateria - 0.01);

  if (dentro !== sim.dentro) {
    sim.dentro = dentro;
    await registrarAlerta(dentro ? 'voltou_area' : 'saiu_area', `${PET_NOME} ${dentro ? 'voltou para a área segura' : 'saiu da área segura'}`);
  }

  if (db) {
    const intervalo = dentro ? 10000 : 3000;
    if (forcar || Date.now() - ultimoEnvioSim > intervalo) {
      ultimoEnvioSim = Date.now();
      await fs.setDoc(fs.doc(db, 'pets', PET_ID), { ...estado, atualizadoEm: fs.serverTimestamp() });
    }
  } else {
    renderEstado(estado);
  }
}

async function registrarAlerta(tipo, mensagem) {
  const a = { pet: PET_ID, tipo, mensagem, lat: sim.lat, lng: sim.lng };
  if (db) {
    await fs.addDoc(fs.collection(db, 'alertas'), { ...a, criadoEm: fs.serverTimestamp() });
  } else {
    alertasLocais.unshift({ ...a, data: new Date() });
    alertasLocais = alertasLocais.slice(0, 30);
    renderAlertas(alertasLocais);
  }
}

let timerSim = null;
function ligarSimulador() {
  if (!timerSim) timerSim = setInterval(() => passoSimulador().catch(console.error), 1000);
}
function marcarPasseio(ligado) {
  $('btnPasseio').classList.toggle('ativo', ligado);
  $('btnPasseio').querySelector('span').textContent = ligado ? 'Parar fuga simulada' : 'Iniciar fuga simulada';
}

document.querySelectorAll('[data-sim]').forEach((b) => b.addEventListener('click', async () => {
  ligarSimulador();
  const acao = b.dataset.sim;
  if (acao === 'dentro') { sim.rota = null; sim.lat = area.lat + 0.00005; sim.lng = area.lng - 0.00015; }
  if (acao === 'fora') {
    sim.rota = null;
    const d = (area.raio + 40) / 111320;
    sim.lat = area.lat - d * 0.6; sim.lng = area.lng - d * 0.9;
  }
  if (acao === 'coleira') {
    sim.coleiraNoPet = !sim.coleiraNoPet;
    await registrarAlerta(sim.coleiraNoPet ? 'coleira_colocada' : 'coleira_removida',
      sim.coleiraNoPet ? `${PET_NOME} está com a coleira de novo` : `${PET_NOME} está sem a coleira (coleira removida)`);
  }
  if (acao === 'passeio') { sim.rota = sim.rota ? null : rotaFuga(); }
  marcarPasseio(!!sim.rota);
  passoSimulador(true).catch(console.error);
}));

// ============================================================ conexão
function definirConexao(texto, classe) {
  $('conexaoTexto').textContent = texto;
  $('conexao').className = 'conexao ' + classe;
}

async function conectarFirebase() {
  const app = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSAO}/firebase-app.js`);
  fs = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSAO}/firebase-firestore.js`);
  db = fs.getFirestore(app.initializeApp(firebaseConfig));

  fs.onSnapshot(fs.doc(db, 'pets', PET_ID), (snap) => {
    definirConexao('Ao vivo', 'ao-vivo');
    if (!snap.exists()) { $('status').textContent = 'Nenhum dado da coleira ainda. Ligue a coleira ou use a área de testes.'; return; }
    const d = snap.data();
    renderEstado({ ...d, atualizadoEm: paraData(d.atualizadoEm) || new Date() });
  }, (err) => {
    console.error(err);
    definirConexao('Erro no Firebase', 'erro');
    $('status').textContent = 'Erro ao ler o Firebase: ' + err.message;
  });

  fs.onSnapshot(fs.doc(db, 'config', 'area'), (snap) => {
    if (!snap.exists()) return;
    const d = snap.data();
    area = { lat: d.lat, lng: d.lng, raio: d.raio };
    desenharArea();                 // um rascunho em andamento continua sendo mostrado
  });

  const q = fs.query(fs.collection(db, 'alertas'), fs.orderBy('criadoEm', 'desc'), fs.limit(40));
  fs.onSnapshot(q, (snap) => {
    const lista = snap.docs.map((d) => ({ ...d.data(), data: paraData(d.data().criadoEm) }))
      .filter((a) => !a.pet || a.pet === PET_ID);
    renderAlertas(lista);
  });
}

// atualiza "há X s" e detecta coleira sem sinal
setInterval(() => { if (ultimoEstado) renderEstado(ultimoEstado, false); }, 5000);
new ResizeObserver(() => { map.invalidateSize(); desenharBpm(); }).observe($('map'));

renderAlertas([]);
desenharArea();
if (configurado) {
  conectarFirebase().catch((err) => {
    console.error(err);
    definirConexao('Sem Firebase: simulação', 'erro');
    db = null; ligarSimulador();
  });
} else {
  definirConexao('Modo simulação', 'simulacao');
  ligarSimulador();
}
