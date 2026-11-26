import { PET_ID, PET_NOME, AREA_PADRAO, SEM_SINAL_SEGUNDOS } from './firebase-config.js';
import {
  configurado, abrirFirestore, PERFIL_PADRAO, perfilLocal, salvarPerfilLocal, avistamentosLocais,
  adicionarAvistamentoLocal, CHAVE_PERFIL, CHAVE_AVISTAMENTOS, telefoneWhatsApp, telefoneBonito, urlPaginaQR, reduzirFoto
} from './perfil-dados.js';
import {
  iniciarEncontros, ouvirEncontros, criarEncontro, atualizarEncontro, responder, linkRota, ESTADO_PET, ONDE_FICA, STATUS
} from './encontros.js';
import { montarComunidade } from './comunidade-ui.js';
import { exigirLogin, sair, emailAtual } from './conta.js';
import { analisar, graficoRepouso, graficoAtividade, historicoExemplo, dataLocal, diasAtras } from './saude.js';

const $ = (id) => document.getElementById(id);

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
let perfil = configurado ? { ...PERFIL_PADRAO } : perfilLocal();   // nome, foto, telefone, recado, perdido
let formSujo = false, fotoNova;                                    // edição do perfil ainda não salva
let idsAvistados = null;                                           // avistamentos já vistos (para avisar só os novos)
const nomePet = () => perfil.nome || PET_NOME;
let reconhecido = { fora: false, coleira: false };              // alertas que o tutor já viu ("Entendi" / "Pet encontrado")
let saida = null;                                                 // ponto e hora em que o pet saiu da área segura
let encontros = [];
let comunidade = null;                                            // rede do bairro (montada depois do login)                                               // avisos de quem achou o pet pelo QR
let diasSaude = {};                                                // resumos diários: { 'AAAA-MM-DD': {...} }
let analiseSaude = null;
const CHAVE_SAUDE = 'coleira-saude-' + PET_ID;


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
const camadaAchados = L.layerGroup().addTo(map);

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
  let dist = temPosicao ? Math.round(map.distance([a.lat, a.lng], [e.lat, e.lng])) : null;
  const fora = dist != null && dist > a.raio;

  // Sem conectividade móvel: fora da área não há posição ao vivo.
  // Guardamos só o ponto em que ele saiu e mostramos esse "último ponto registrado".
  if (fora) {
    if (!saida) saida = { lat: e.lat, lng: e.lng, dist, em: e.atualizadoEm || new Date() };
    dist = saida.dist;
  } else {
    saida = null;
    reconhecido.fora = false;
  }
  if (e.coleiraNoPet) reconhecido.coleira = false;
  const ponto = saida || (temPosicao ? { lat: e.lat, lng: e.lng } : null);

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
  $('latitude').textContent = ponto ? ponto.lat.toFixed(6) : '-';
  $('longitude').textContent = ponto ? ponto.lng.toFixed(6) : '-';
  $('atualizado').textContent = haQuanto(e.atualizadoEm);

  // mapa: dentro da área, a posição sincronizada; fora, o último ponto registrado
  if (ponto) {
    marcadorPet.setLatLng([ponto.lat, ponto.lng]).setIcon(iconePet(fora));
    marcadorPet.bindPopup(fora
      ? `<b>${nomePet()}</b> saiu da área segura às ${fmtHora(saida.em)}.<br>Último ponto registrado pela coleira.`
      : `<b>${nomePet()}</b> está dentro da área segura`);
    if (novo && !fora) adicionarPegada(e.lat, e.lng);
  }

  atualizarStatus(e, fora, dist);
  if (novo) verificarMudancas(e, fora);
  if (novo && Date.now() - ultimoRenderSaude > 3000) renderSaude();
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

// encontro ainda não encerrado = alguém confirmou pelo QR que está com o pet / viu o pet
const encontroAtivo = () => encontros.find((x) => x.status !== 'resolvido') || null;
const quemAchou = (enc) => enc?.achador?.nome?.trim() || 'Uma pessoa';

function atualizarStatus(e, fora, dist) {
  e = e || { coleiraNoPet: true };
  const enc = encontroAtivo();
  let estado, etiqueta, texto;
  if (enc) {
    estado = 'encontrado'; etiqueta = 'Pet encontrado';
    texto = `${nomePet()} foi encontrado por ${quemAchou(enc)} às ${fmtHora(enc.criadoEm)}`
      + (enc.estadoPet ? ` (${(ESTADO_PET[enc.estadoPet] || '').toLowerCase()})` : '')
      + `. ${enc.status === 'a_caminho' ? 'Você avisou que está a caminho.' : 'Veja o ponto exato e combine a busca.'}`;
  } else if (fora) {
    estado = 'fora'; etiqueta = 'Fora da área';
    texto = `${nomePet()} saiu da área segura às ${fmtHora(saida?.em)}, a ${dist} m de casa. Fora da área a coleira não envia a posição: o LED pisca e quem encontrar pode avisar você pelo QR.`;
  } else if (semSinal(e)) {
    estado = 'sem-sinal'; etiqueta = 'Fora do Wi-Fi';
    texto = `A coleira não sincroniza desde ${fmtHora(e.atualizadoEm)}. Ela continua medindo os sinais e conferindo a área segura, e envia tudo quando voltar ao Wi-Fi.`;
  } else if (dist == null) {
    estado = 'aguardando'; etiqueta = 'Procurando GPS';
    texto = 'A coleira está ligada e aguardando sinal de GPS.';
  } else {
    estado = 'dentro'; etiqueta = 'Em casa';
    texto = `${nomePet()} está dentro da área segura. Tudo tranquilo por aqui.`;
  }
  if (perfil.perdido && !enc) {
    etiqueta = 'Modo perdido';
    texto = `Procurando ${nomePet()}. A página do QR está pedindo ajuda a quem encontrá-lo.`
      + (saida ? ` Ele saiu da área às ${fmtHora(saida.em)}.` : '');
  }
  document.body.dataset.estado = estado;
  $('etiquetaEstado').textContent = etiqueta;
  $('estadoMenu').textContent = etiqueta;
  $('status').textContent = texto;

  const ponto = saida || (e.lat && e.lng ? { lat: e.lat, lng: e.lng } : null);
  const pedidoAjuda = (inicio) => linkZap(inicio + (ponto ? ` Último ponto registrado: ${linkMapa(ponto.lat, ponto.lng)} ` : ' ')
    + `Se encontrar, escaneie o QR da coleira ou abra: ${urlPaginaQR()}`);

  $('bannerMapa').hidden = !ponto;
  $('bannerMapa').lastChild.textContent = 'Abrir no Google Maps';
  if (ponto) $('bannerMapa').href = linkMapa(ponto.lat, ponto.lng);
  $('bannerZapTexto').textContent = 'Pedir ajuda no WhatsApp';

  $('banner').classList.remove('encontrado');
  if (enc) {
    const tel = telefoneWhatsApp(enc.achador?.telefone);
    $('banner').hidden = false;
    $('banner').classList.remove('coleira', 'perdido');
    $('banner').classList.add('encontrado');
    usar($('bannerIcone'), 'i-check');
    $('bannerTitulo').textContent = `${nomePet()} foi encontrado!`;
    $('bannerTexto').textContent = [
      `${quemAchou(enc)}${enc.achador?.telefone ? ' · ' + telefoneBonito(enc.achador.telefone) : ''} confirmou pelo QR às ${fmtHora(enc.criadoEm)}.`,
      [ESTADO_PET[enc.estadoPet], ONDE_FICA[enc.ondeFica]].filter(Boolean).join(' · ')
    ].filter(Boolean).join(' ');
    $('bannerMapa').hidden = !(enc.lat && enc.lng);
    if (enc.lat && enc.lng) $('bannerMapa').href = linkRota(enc.lat, enc.lng);
    $('bannerMapa').lastChild.textContent = 'Traçar rota até lá';
    $('bannerZap').hidden = tel.length < 12;
    $('bannerZap').href = `https://wa.me/${tel}?text=${encodeURIComponent(`Olá! Sou o tutor de ${nomePet()}. Obrigado por avisar!`)}`;
    $('bannerZapTexto').textContent = `Falar com ${quemAchou(enc).split(' ')[0]}`;
    $('btnEncontradoBanner').hidden = false;
    $('btnEncontradoBanner').lastChild.textContent = 'Já estou com ele';
    $('btnPerdidoBanner').hidden = true;
    $('btnEntendi').hidden = true;
    return;
  }
  $('bannerZap').hidden = false;
  $('btnEncontradoBanner').lastChild.textContent = 'Pet encontrado';

  if (perfil.perdido) {
    const desde = perfil.perdidoDesde ? fmtHora(new Date(perfil.perdidoDesde)) : 'agora';
    $('banner').hidden = false;
    $('banner').classList.remove('coleira');
    $('banner').classList.add('perdido');
    usar($('bannerIcone'), 'i-megafone');
    $('bannerTitulo').textContent = 'Modo pet perdido ativo';
    $('bannerTexto').textContent = `Desde ${desde}. A página do QR pede ajuda e você é avisado quando alguém encontrar ${nomePet()}.`;
    $('bannerZap').href = pedidoAjuda(`${nomePet()} está perdido!`);
    $('btnEncontradoBanner').hidden = false;
    $('btnPerdidoBanner').hidden = true;
    $('btnEntendi').hidden = true;
    return;
  }
  $('banner').classList.remove('perdido');
  $('btnEncontradoBanner').hidden = true;

  const problema = fora && !reconhecido.fora ? 'fora' : !e.coleiraNoPet && !reconhecido.coleira ? 'coleira' : null;
  $('banner').hidden = !problema;
  if (problema) {
    const msg = problema === 'fora'
      ? `Saiu às ${fmtHora(saida?.em)}, a ${dist} m de casa. A coleira está piscando o LED; quem encontrar pode avisar você pelo QR.`
      : `A coleira de ${nomePet()} foi removida.`;
    $('banner').classList.toggle('coleira', problema === 'coleira');
    usar($('bannerIcone'), problema === 'fora' ? 'i-corre' : 'i-tag');
    $('bannerTitulo').textContent = problema === 'fora' ? `${nomePet()} saiu da área segura` : 'Coleira removida!';
    $('bannerTexto').textContent = msg;
    $('bannerZap').href = pedidoAjuda(problema === 'fora' ? `${nomePet()} fugiu de casa!` : `A coleira de ${nomePet()} foi removida.`);
    $('btnPerdidoBanner').hidden = problema !== 'fora';
    $('btnEntendi').hidden = false;
    $('banner').dataset.problema = problema;
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
  voltou_area: ['bom', 'i-casa'], coleira_colocada: ['bom', 'i-check'],
  avistamento: ['achado', 'i-olho'], batimento_alto: ['aviso', 'i-coracao'], batimento_baixo: ['aviso', 'i-coracao'], modo_perdido: ['grave', 'i-megafone'], pet_encontrado: ['bom', 'i-check']
};
const chaveAlerta = (a) => a.id || `${a.data?.getTime?.()}|${a.lat}|${a.mensagem}`;
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
    ul.append(li);
  } else lista.forEach((a, i) => {
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
    if (a.contatoNome || a.contatoTelefone) msg.append(linhaContato(a));
    const t = document.createElement('time');
    t.textContent = a.data ? a.data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
    li.append(ic, msg, t);
    ul.append(li);
  });
  // os 3 mais recentes também aparecem no Início
  $('alertasResumo').replaceChildren(...[...ul.children].slice(0, 3).map((li) => {
    const c = li.cloneNode(true); c.style.animationDelay = '0ms'; return c;
  }));
  ultimaLista = lista;
  atualizarSelo();
  verificarAvistamentos(lista);
}

// selo de alertas não lidos no menu
let ultimaLista = [];
let vistoAte = (() => { try { return +localStorage.getItem('coleira-alertas-vistos') || Date.now(); } catch { return Date.now(); } })();
function atualizarSelo() {
  if (secaoAtual === 'alertas') marcarAlertasLidos();
  const n = ultimaLista.filter((a) => a.data && a.data.getTime() > vistoAte).length;
  $('seloAlertas').hidden = !n;
  $('seloAlertas').textContent = n > 9 ? '9+' : n;
}
function marcarAlertasLidos() {
  const maisNovo = Math.max(Date.now(), ...ultimaLista.map((a) => a.data?.getTime() || 0));
  vistoAte = maisNovo;
  try { localStorage.setItem('coleira-alertas-vistos', String(maisNovo)); } catch { /* ok */ }
  $('seloAlertas').hidden = true;
}

function linhaContato(a) {
  const c = document.createElement('span'); c.className = 'contato';
  c.textContent = 'Contato: ' + [a.contatoNome, telefoneBonito(a.contatoTelefone)].filter(Boolean).join(' · ');
  const tel = telefoneWhatsApp(a.contatoTelefone);
  if (tel.length >= 12) {
    const z = document.createElement('a');
    z.href = `https://wa.me/${tel}`; z.target = '_blank'; z.rel = 'noopener'; z.textContent = 'chamar no WhatsApp';
    c.append(' ', z);
  }
  return c;
}

// pins azuis com o "olho": onde alguém encontrou o pet pela página do QR
function desenharAchados(lista) {
  camadaAchados.clearLayers();
  lista.filter((a) => a.tipo === 'avistamento' && a.lat && a.lng).slice(0, 15).forEach((a) => {
    const novo = idsAvistados && !idsAvistados.has(chaveAlerta(a));
    const pop = document.createElement('div');
    const b = document.createElement('b'); b.textContent = a.mensagem;
    const quando = document.createElement('div'); quando.textContent = a.data ? a.data.toLocaleString('pt-BR') : '';
    pop.append(b, quando);
    if (a.precisao) { const p = document.createElement('div'); p.textContent = `Precisão de ~${a.precisao} m`; pop.append(p); }
    if (a.contatoNome || a.contatoTelefone) pop.append(linhaContato(a));
    L.marker([a.lat, a.lng], {
      zIndexOffset: 900,
      icon: L.divIcon({ className: '', html: `<div class="mk-achado ${novo ? 'novo' : ''}"><svg><use href="#i-olho"/></svg></div>`, iconSize: [40, 40], iconAnchor: [20, 40], popupAnchor: [0, -38] })
    }).bindPopup(pop).addTo(camadaAchados);
  });
}

function verificarAvistamentos(lista) {
  const avs = lista.filter((a) => a.tipo === 'avistamento');
  if (idsAvistados) {
    const novo = avs.find((a) => !idsAvistados.has(chaveAlerta(a)));
    if (novo) {
      avisar(`${novo.mensagem}`);
      const temPos = novo.lat && novo.lng;
      if (temPos) map.flyTo([novo.lat, novo.lng], 18);
      mostrarAviso(`Alguém encontrou ${nomePet()}!`, temPos ? 'Ver no mapa' : null,
        temPos ? () => { irPara('mapa', true); setTimeout(() => map.flyTo([novo.lat, novo.lng], 18), 120); } : null, 12000);
    }
  }
  idsAvistados = new Set(avs.map(chaveAlerta));
}

function renderAlertasLocais() {
  const avs = avistamentosLocais().map((a) => ({ ...a, data: new Date(a.data) }));
  renderAlertas([...alertasLocais, ...avs].sort((x, y) => y.data - x.data));
}

function verificarMudancas(e, fora) {
  if (anterior.fora === false && fora) avisar(`${nomePet()} saiu da área segura!`);
  if (anterior.coleiraNoPet === true && !e.coleiraNoPet) avisar(`A coleira de ${nomePet()} foi removida!`);
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
  if (db) await fs.setDoc(fs.doc(db, 'pets', PET_ID, 'config', 'area'), { ...a, atualizadoEm: fs.serverTimestamp() });
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

  // saúde (simulação acelerada: cada segundo conta como 1 minuto da coleira)
  const hoje = diaDeHoje(true);
  const mov = sim.ultPos ? map.distance(sim.ultPos, [sim.lat, sim.lng]) : 0;
  sim.ultPos = [sim.lat, sim.lng];
  if (mov > 1) { hoje.distanciaM += Math.round(mov); hoje.minutosAtivos += 1; sim.parado = 0; } else sim.parado = (sim.parado || 0) + 1;
  const repouso = sim.coleiraNoPet && sim.parado >= 3;
  let bpm = sim.coleiraNoPet ? Math.round(base + (Math.random() - 0.5) * 10) : 0;
  if (repouso) {
    bpm = sim.coracao > 0 ? Math.round(118 + Math.random() * 6) : Math.round(86 + Math.random() * 6);
    sim.janela = [...(sim.janela || []), bpm].slice(-8);
    if (sim.parado % 4 === 0) { hoje.bpmRepousoSoma += bpm; hoje.bpmRepousoN += 1; }
  } else sim.janela = [];
  if (sim.coracao > 0) sim.coracao--;
  const bpmRepouso = sim.janela.length >= 3 ? Math.round(sim.janela.reduce((a, b) => a + b, 0) / sim.janela.length) : 0;

  const estado = {
    nome: nomePet(), lat: sim.lat, lng: sim.lng, gpsFix: true, satelites: 8,
    batimentos: bpm,
    coleiraNoPet: sim.coleiraNoPet, dentroArea: dentro, distancia: Math.round(dist),
    bateria: Math.round(sim.bateria), atualizadoEm: new Date(),
    bpmRepouso, emRepouso: repouso, saudeAlerta: sim.coracao > 0 && bpmRepouso > 105 ? 'alto' : ''
  };
  if (estado.saudeAlerta && !sim.avisouCoracao) {
    sim.avisouCoracao = true;
    await registrarAlerta('batimento_alto', `${nomePet()} está com o batimento em repouso acima do normal dele`);
  }
  if (!sim.coracao) sim.avisouCoracao = false;
  await salvarDiaSim(hoje);
  sim.bateria = Math.max(5, sim.bateria - 0.01);

  if (dentro !== sim.dentro) {
    sim.dentro = dentro;
    await registrarAlerta(dentro ? 'voltou_area' : 'saiu_area', `${nomePet()} ${dentro ? 'voltou para a área segura' : 'saiu da área segura'}`);
  }

  // fora da área a coleira está longe do Wi-Fi de casa: só o registro da saída chega
  if (!dentro) {
    if (sim.saidaEnviada) return;
    sim.saidaEnviada = true;
    forcar = true;
  } else sim.saidaEnviada = false;

  if (db) {
    const intervalo = 10000;
    if (forcar || Date.now() - ultimoEnvioSim > intervalo) {
      ultimoEnvioSim = Date.now();
      await fs.setDoc(fs.doc(db, 'pets', PET_ID), { ...estado, atualizadoEm: fs.serverTimestamp() });
    }
  } else {
    renderEstado(estado);
  }
}

let ultimoSalvoSaude = 0;
async function salvarDiaSim(hoje, forcar = false) {
  if (!forcar && Date.now() - ultimoSalvoSaude < (db ? 10000 : 3000)) return;
  ultimoSalvoSaude = Date.now();
  if (db) await fs.setDoc(fs.doc(db, 'pets', PET_ID, 'saude', hoje.data), { pet: PET_ID, ...hoje, atualizadoEm: fs.serverTimestamp() });
  else { try { localStorage.setItem(CHAVE_SAUDE, JSON.stringify(diasSaude)); } catch { /* ok */ } renderSaude(); }
}

async function registrarAlerta(tipo, mensagem, pos = sim) {
  const a = { pet: PET_ID, tipo, mensagem, lat: pos?.lat ?? null, lng: pos?.lng ?? null };
  if (db) {
    await fs.addDoc(fs.collection(db, 'pets', PET_ID, 'alertas'), { ...a, criadoEm: fs.serverTimestamp() });
  } else {
    alertasLocais.unshift({ ...a, data: new Date() });
    alertasLocais = alertasLocais.slice(0, 30);
    renderAlertasLocais();
  }
}

async function simularAvistamento() {
  const dados = {
    lat: +(sim.lat + 0.00012).toFixed(6), lng: +(sim.lng + 0.00009).toFixed(6), precisao: 12,
    achador: { nome: 'Ana (simulação)', telefone: '71988887777' },
    mensagem: 'Está aqui comigo na padaria da esquina.', estadoPet: 'assustado', ondeFica: 'comigo', foto: ''
  };
  const id = await criarEncontro(dados);
  const a = {
    pet: PET_ID, tipo: 'avistamento', encontroId: id, mensagem: `Alguém encontrou ${nomePet()}: "${dados.mensagem}"`,
    lat: dados.lat, lng: dados.lng, precisao: dados.precisao,
    contatoNome: dados.achador.nome, contatoTelefone: dados.achador.telefone
  };
  if (db) await fs.addDoc(fs.collection(db, 'pets', PET_ID, 'alertas'), { ...a, criadoEm: fs.serverTimestamp() });
  else { adicionarAvistamentoLocal({ ...a, data: new Date().toISOString() }); renderAlertasLocais(); }
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
      sim.coleiraNoPet ? `${nomePet()} está com a coleira de novo` : `${nomePet()} está sem a coleira (coleira removida)`);
  }
  if (acao === 'passeio') { sim.rota = sim.rota ? null : rotaFuga(); }
  if (acao === 'achado') await simularAvistamento();
  if (acao === 'coracao') {
    sim.rota = null; sim.lat = area.lat + 0.00005; sim.lng = area.lng - 0.00015; sim.ultPos = [sim.lat, sim.lng];
    sim.coleiraNoPet = true; sim.parado = 3; sim.coracao = 25;
    mostrarAviso('Simulando batimento acima do normal em repouso por ~25 s', 'Ver saúde', () => irPara('saude', true), 6000);
  }
  if (acao === 'historico') await gerarHistoricoExemplo();
  if (acao === 'vizinhos') {
    if (!comunidade?.membro()) { mostrarAviso('Primeiro entre na rede do bairro.', 'Abrir', () => irPara('comunidade', true), 6000); return; }
    if (!comunidade.alertaAtivo()) { mostrarAviso(`Ative o modo perdido e publique o alerta de ${nomePet()} no bairro.`, 'Abrir', () => irPara('comunidade', true), 6000); return; }
    if (comunidade.simularVizinhos()) mostrarAviso('Dois vizinhos começaram a procurar e um avistou o pet.', 'Ver', () => irPara('comunidade', true), 7000);
    else mostrarAviso('Com o Firebase configurado, use uma segunda conta para testar os vizinhos.', null, null, 6000);
    return;
  }
  marcarPasseio(!!sim.rota);
  passoSimulador(true).catch(console.error);
}));

// ============================================================ perfil, QR e modo perdido
function aplicarPerfil() {
  const enc = encontroAtivo();
  $('nomePet').textContent = nomePet();
  document.title = `${nomePet()} | Coleira inteligente`;
  document.body.dataset.perdido = String(!!perfil.perdido && !enc);
  document.body.dataset.encontrado = String(!!enc);
  $('nomePetMenu').textContent = nomePet();
  $('pontoPerdido').hidden = !perfil.perdido && !enc;
  ['btnPerdido', 'btnPerdido2'].forEach((id) => {
    $(id).querySelector('span').textContent = enc ? 'Já estou com ele' : perfil.perdido ? 'Pet encontrado' : 'Meu pet sumiu';
    usar($(id).querySelector('use'), enc || perfil.perdido ? 'i-check' : 'i-megafone');
  });
  if (enc) {
    $('mpTitulo').textContent = `${nomePet()} foi encontrado!`;
    $('mpTexto').textContent = `${quemAchou(enc)}${enc.achador?.telefone ? ' (' + telefoneBonito(enc.achador.telefone) + ')' : ''} confirmou pelo QR às ${fmtHora(enc.criadoEm)}`
      + `${enc.lat ? ' e enviou a localização exata' : ''}. Veja o cartão do encontro abaixo e toque em "Já estou com ele" quando buscar ${nomePet()}.`;
  } else {
    $('mpTitulo').textContent = perfil.perdido ? 'Modo pet perdido ATIVO' : 'Modo pet perdido desligado';
    $('mpTexto').textContent = perfil.perdido
      ? `Desde ${perfil.perdidoDesde ? fmtHora(new Date(perfil.perdidoDesde)) : 'agora'}. A coleira pisca o LED sem parar e a página do QR pede ajuda a quem encontrar ${nomePet()}.`
      : 'Se o pet sumir, ative para a coleira piscar o LED sem parar e a página do QR pedir ajuda a quem encontrá-lo.';
  }
  if (!formSujo) preencherPerfil();
  document.querySelectorAll('[data-nome-pet]').forEach((el) => { el.textContent = nomePet(); });
  if (ultimoEstado) renderEstado(ultimoEstado, false);
  else atualizarStatus(null, false, null);
  comunidade?.atualizarPet();
}

function preencherPerfil() {
  $('perfilNome').value = perfil.nome || PET_NOME;
  $('perfilTel').value = telefoneBonito(perfil.telefone);
  $('perfilRecado').value = perfil.recado || '';
  mostrarFoto(perfil.foto);
}

function mostrarFoto(url) {
  $('perfilFotoPrev').hidden = !url;
  if (url) $('perfilFotoPrev').src = url;
  document.querySelector('.foto-escolher .foto-padrao').style.display = url ? 'none' : '';
}

function marcarPerfilSujo() {
  formSujo = true;
  $('dicaPerfil').className = 'dica';
  $('dicaPerfil').textContent = 'Alterações não salvas';
}
['perfilNome', 'perfilTel', 'perfilRecado'].forEach((id) => $(id).addEventListener('input', marcarPerfilSujo));

$('perfilFoto').addEventListener('change', async () => {
  const arq = $('perfilFoto').files[0];
  if (!arq) return;
  try {
    fotoNova = await reduzirFoto(arq);
    mostrarFoto(fotoNova);
    marcarPerfilSujo();
  } catch (err) {
    $('dicaPerfil').textContent = err.message;
  }
  $('perfilFoto').value = '';
});

async function gravarPerfil(campos) {
  if (db) await fs.setDoc(fs.doc(db, 'perfis', PET_ID), { ...campos, atualizadoEm: fs.serverTimestamp() }, { merge: true });
  else if (!salvarPerfilLocal({ ...perfil, ...campos })) throw new Error('o navegador não deixou salvar (armazenamento cheio ou bloqueado)');
  perfil = { ...perfil, ...campos };
}

$('formPerfil').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const tel = $('perfilTel').value.replace(/\D/g, '');
  if (tel && tel.length < 10) {
    $('dicaPerfil').className = 'dica';
    $('dicaPerfil').textContent = 'Confira o telefone: use DDD + número.';
    $('perfilTel').focus();
    return;
  }
  const campos = {
    nome: $('perfilNome').value.trim() || PET_NOME,
    telefone: tel,
    recado: $('perfilRecado').value.trim(),
    foto: fotoNova !== undefined ? fotoNova : perfil.foto || ''
  };
  $('btnSalvarPerfil').disabled = true;
  try {
    await gravarPerfil(campos);
    formSujo = false; fotoNova = undefined;
    $('dicaPerfil').className = 'dica salvo';
    $('dicaPerfil').textContent = db ? 'Perfil salvo. A página do QR já mostra os novos dados.' : 'Perfil salvo neste navegador (modo simulação).';
    aplicarPerfil();
  } catch (err) {
    console.error(err);
    $('dicaPerfil').className = 'dica';
    $('dicaPerfil').textContent = 'Não foi possível salvar: ' + err.message;
  }
  $('btnSalvarPerfil').disabled = false;
});

function desenharQR() {
  const url = urlPaginaQR();
  $('qrAbrir').href = url;
  const local = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local) {
    $('qrDica').className = 'dica qr-dica atencao';
    $('qrDica').textContent = 'Você está abrindo o site pelo computador. Gere o QR pelo site publicado (GitHub Pages), senão ele aponta para um endereço que só existe aqui.';
  }
  if (typeof qrcode !== 'function') {
    $('qrDica').textContent = 'Não consegui carregar o gerador de QR. Confira a internet e recarregue.';
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount(), margem = 3, px = 10, cv = $('qrCanvas'), ctx = cv.getContext('2d');
  cv.width = cv.height = (n + margem * 2) * px;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#1d1b3a';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) ctx.fillRect((c + margem) * px, (r + margem) * px, px, px);
  }
  $('qrBaixar').href = cv.toDataURL('image/png');
  $('qrBaixar').download = `qr-coleira-${PET_ID}.png`;
}

// enc: o encontro que levou o pet de volta (para registrar quem encontrou)
async function definirPerdido(valor, enc = null) {
  const campos = { perdido: valor, perdidoDesde: valor ? new Date() : null, encontrado: null };
  if (db) {
    await fs.setDoc(fs.doc(db, 'perfis', PET_ID), { perdido: valor, perdidoDesde: valor ? fs.serverTimestamp() : null, encontrado: null }, { merge: true });
    perfil = { ...perfil, ...campos };
  } else {
    await gravarPerfil(campos);
  }
  aplicarPerfil();
  const pos = enc?.lat ? enc : ultimoEstado?.lat ? ultimoEstado : null;
  await registrarAlerta(valor ? 'modo_perdido' : 'pet_encontrado',
    valor ? `Modo pet perdido ativado para ${nomePet()}`
      : enc ? `${nomePet()} foi encontrado por ${quemAchou(enc)} e já está com você. Modo perdido desativado`
        : `${nomePet()} foi encontrado. Modo perdido desativado`, pos);
  sincronizarAlertaBairro?.(valor);
}

async function ativarPerdido() {
  try {
    await definirPerdido(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    mostrarAviso('Modo pet perdido ativado', 'Desfazer', () => definirPerdido(false).catch(falhaPerdido));
  } catch (err) { falhaPerdido(err); }
}

// O tutor está com o pet: encerra os encontros abertos, desliga o modo perdido e some com os avisos.
async function marcarEncontrado() {
  try {
    reconhecido = { fora: true, coleira: true };   // o tutor está com o pet: não insistir no aviso
    if (timerSim) { sim.rota = null; sim.lat = area.lat + 0.00005; sim.lng = area.lng - 0.00015; sim.coleiraNoPet = true; marcarPasseio(false); }
    const abertos = encontros.filter((x) => x.status !== 'resolvido');
    const estavaPerdido = !!perfil.perdido;
    for (const enc of abertos) {
      await atualizarEncontro(enc.id, { status: 'resolvido' });
      await responder(enc.id, 'tutor', `Já estou com ${nomePet()}. Muito obrigado pela ajuda!`);
    }
    if (estavaPerdido || perfil.encontrado) await definirPerdido(false, abertos[0]);
    else { aplicarPerfil(); }
    mostrarAviso(`Que bom que ${nomePet()} voltou!`, estavaPerdido && !abertos.length ? 'Desfazer' : null,
      estavaPerdido && !abertos.length ? () => definirPerdido(true).catch(falhaPerdido) : null);
  } catch (err) { falhaPerdido(err); }
}
function falhaPerdido(err) { console.error(err); mostrarAviso('Não foi possível mudar o modo perdido: ' + err.message, null, null, 6000); }

function alternarPerdido() {
  if (perfil.perdido || encontroAtivo()) return marcarEncontrado();
  const d = $('dlgPerdido');
  if (typeof d.showModal === 'function') d.showModal(); else ativarPerdido();
}
$('btnPerdido').addEventListener('click', alternarPerdido);
$('btnPerdido2').addEventListener('click', alternarPerdido);
$('dlgPerdido').addEventListener('close', () => { if ($('dlgPerdido').returnValue === 'ativar') ativarPerdido(); });
$('btnEncontradoBanner').addEventListener('click', marcarEncontrado);

// modo simulação: a página do QR aberta em outra aba do mesmo navegador conversa por aqui
window.addEventListener('storage', (ev) => {
  if (db) return;
  if (ev.key === CHAVE_AVISTAMENTOS) renderAlertasLocais();
  if (ev.key === CHAVE_PERFIL) { perfil = perfilLocal(); aplicarPerfil(); }
});

// ============================================================ saúde e atividade
const vazioDia = (data) => ({ data, minutosAtivos: 0, distanciaM: 0, bpmRepousoSoma: 0, bpmRepousoN: 0 });
function diaDeHoje(criar = false) {
  const hoje = dataLocal();
  if (!diasSaude[hoje] && criar) diasSaude[hoje] = vazioDia(hoje);
  return diasSaude[hoje] || vazioDia(hoje);
}
const numero = (v) => (v == null || v === '' ? 0 : +v);
function normalizarDia(x) {
  return {
    data: x.data, minutosAtivos: numero(x.minutosAtivos), distanciaM: numero(x.distanciaM),
    bpmRepousoSoma: numero(x.bpmRepousoSoma), bpmRepousoN: numero(x.bpmRepousoN)
  };
}

function carregarSaudeLocal() {
  try { diasSaude = JSON.parse(localStorage.getItem(CHAVE_SAUDE)) || {}; } catch { diasSaude = {}; }
  if (!Object.keys(diasSaude).length) {
    historicoExemplo().forEach((d) => { diasSaude[d.data] = d; });
    const h = vazioDia(dataLocal());
    Object.assign(h, { minutosAtivos: 18, distanciaM: 820, bpmRepousoSoma: 88 * 25, bpmRepousoN: 25 });
    diasSaude[h.data] = h;
  }
}

async function gerarHistoricoExemplo() {
  const lista = historicoExemplo();
  if (db) {
    await Promise.all(lista.map((d) => fs.setDoc(fs.doc(db, 'pets', PET_ID, 'saude', d.data), { pet: PET_ID, ...d, exemplo: true })));
  } else {
    lista.forEach((d) => { diasSaude[d.data] = d; });
    try { localStorage.setItem(CHAVE_SAUDE, JSON.stringify(diasSaude)); } catch { /* ok */ }
    renderSaude();
  }
  mostrarAviso('Histórico de exemplo dos últimos 13 dias criado', 'Ver saúde', () => irPara('saude', true), 6000);
}

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`);
const CHIP = { aprendendo: 'Aprendendo', 'sem-dados': 'Sem repouso hoje', normal: 'Normal dele', alto: 'Acima do normal', baixo: 'Abaixo do normal' };
const ICONE_PERCEBIDO = { bom: 'i-check', aviso: 'i-sino', alerta: 'i-coracao', info: 'i-pata' };
let ultimoRenderSaude = 0;

function renderSaude() {
  ultimoRenderSaude = Date.now();
  const hoje = diaDeHoje();
  const an = analisar({ dias: Object.values(diasSaude), hoje, estado: ultimoEstado, nome: nomePet() });
  analiseSaude = an;
  const problema = an.statusBpm === 'alto' || an.statusBpm === 'baixo';

  // batimento em repouso x faixa normal
  $('cartaoSaudeBpm').className = 'cartao saude-bpm ' + an.statusBpm;
  $('sChip').className = 'chip ' + an.statusBpm;
  $('sChip').textContent = CHIP[an.statusBpm];
  $('sRepouso').textContent = an.referencia != null ? Math.round(an.referencia) : '--';
  $('sRepousoRotulo').textContent = an.agora ? 'bpm em repouso (última sincronização)' : an.repousoHoje ? 'bpm em repouso hoje' : 'bpm';
  const media = an.media || 90, lim = an.limite || 18;
  const lo = media - lim * 2, hi = media + lim * 2, pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  $('sFaixaNormal').style.left = (an.faixa ? pos(an.faixa[0]) : 25) + '%';
  $('sFaixaNormal').style.width = (an.faixa ? pos(an.faixa[1]) - pos(an.faixa[0]) : 50) + '%';
  $('sFaixaMarca').hidden = an.referencia == null;
  if (an.referencia != null) $('sFaixaMarca').style.left = pos(an.referencia) + '%';
  $('sFaixaMin').textContent = an.faixa && !an.aprendendo ? an.faixa[0] : '';
  $('sFaixaMax').textContent = an.faixa && !an.aprendendo ? an.faixa[1] : '';
  $('sFaixaTexto').textContent = an.aprendendo ? 'normal ainda em aprendizado' : `normal de ${nomePet()}`;
  $('sBase').textContent = an.aprendendo
    ? `Aprendendo: ${an.nDias || 0} de 3 dias com repouso suficiente.`
    : `Normal aprendido ${an.fonte === 'coleira' ? 'pela coleira' : 'pelo histórico'} em ${an.nDias} dias: cerca de ${Math.round(an.media)} bpm em repouso.`;

  // atividade de hoje
  const pct = an.pctHoje;
  $('sMinHoje').textContent = hoje.minutosAtivos || 0;
  $('sDistHoje').textContent = fmtDist(hoje.distanciaM || 0);
  $('sNormalAtiv').textContent = an.normalMin ? `${Math.round(an.normalMin)} min · ${fmtDist(an.normalDist || 0)}` : 'ainda sem histórico';
  $('sPctHoje').textContent = pct != null ? `${Math.round(pct * 100)}%` : '-';
  $('sAnel').setAttribute('stroke-dasharray', `${Math.min(1, pct || 0) * 100} 100`);
  $('sAnel').classList.toggle('completo', (pct || 0) >= 1);

  // o que a coleira percebeu
  $('sInsights').replaceChildren(...an.insights.map((it, i) => {
    const li = document.createElement('li'); li.className = it.tipo; li.style.animationDelay = i * 50 + 'ms';
    const ic = document.createElement('span'); ic.append(iconeSvg(ICONE_PERCEBIDO[it.tipo] || 'i-pata'));
    const p = document.createElement('p'); p.textContent = it.texto;
    li.append(ic, p); return li;
  }));

  // Início e menu
  $('bpmNormal').textContent = problema ? `Repouso ${an.statusBpm === 'alto' ? 'acima' : 'abaixo'} do normal dele`
    : an.aprendendo ? 'Aprendendo o normal dele' : `Normal dele em repouso: ${an.faixa[0]}–${an.faixa[1]} bpm`;
  $('bpmNormal').classList.toggle('alerta', problema);
  $('pontoSaude').hidden = !problema;

  desenharGraficosSaude();
}

function desenharGraficosSaude() {
  if (!analiseSaude) return;
  const hoje = diaDeHoje();
  const dias = Object.values(diasSaude).filter((d) => d.data < hoje.data).sort((a, b) => (a.data < b.data ? -1 : 1));
  graficoRepouso($('gRepouso').querySelector('svg'), dias, hoje, analiseSaude);
  graficoAtividade($('gAtividade').querySelector('svg'), dias, hoje, analiseSaude);
}
const roSaude = new ResizeObserver(() => desenharGraficosSaude());
roSaude.observe($('gRepouso'));
roSaude.observe($('gAtividade'));

// ============================================================ banner: "Entendi" e atalho para o modo perdido
$('btnEntendi').addEventListener('click', () => {
  const p = $('banner').dataset.problema;
  if (p) reconhecido[p] = true;
  if (ultimoEstado) renderEstado(ultimoEstado, false); else $('banner').hidden = true;
});
$('btnPerdidoBanner').addEventListener('click', () => alternarPerdido());

// ============================================================ encontros pelo QR
const fmtTempo = (d) => (d ? `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${fmtHora(d)}` : '-');
function el(tag, cls, texto) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (texto != null) e.textContent = texto;
  return e;
}
function botaoLink(texto, href, icone, cls = 'pilula leve') {
  const a = el('a', cls); a.href = href; a.target = '_blank'; a.rel = 'noopener';
  if (icone) a.append(iconeSvg(icone));
  a.append(document.createTextNode(texto));
  return a;
}

function cartaoEncontro(enc, compacto) {
  const c = el('article', 'encontro ' + enc.status);
  c.dataset.id = enc.id;

  const topo = el('div', 'encontro-topo');
  const tit = el('div');
  tit.append(el('strong', null, enc.status === 'resolvido' ? `${nomePet()} foi recuperado` : `Alguém encontrou ${nomePet()}!`),
    el('small', null, `Aviso enviado pelo QR em ${fmtTempo(enc.criadoEm)}`));
  topo.append(tit, el('span', 'encontro-status ' + enc.status, STATUS[enc.status] || STATUS.aberto));
  c.append(topo);

  const corpo = el('div', 'encontro-corpo');
  if (enc.foto) { const img = el('img', 'encontro-foto'); img.src = enc.foto; img.alt = `Foto enviada por quem encontrou ${nomePet()}`; corpo.append(img); }
  const info = el('div', 'encontro-info');
  const chips = el('div', 'encontro-chips');
  if (enc.estadoPet) chips.append(el('span', 'chip ' + (enc.estadoPet === 'machucado' ? 'alto' : ''), ESTADO_PET[enc.estadoPet] || enc.estadoPet));
  if (enc.ondeFica) chips.append(el('span', 'chip', ONDE_FICA[enc.ondeFica] || enc.ondeFica));
  info.append(chips);

  // localização exata do celular de quem encontrou
  const local = el('p', 'encontro-local');
  if (enc.lat && enc.lng) {
    local.append(iconeSvg('i-mapa'), document.createTextNode(
      `Localização exata enviada ${enc.mapaEm ? 'às ' + fmtHora(enc.mapaEm) : ''}${enc.precisao ? ` · precisão de ~${enc.precisao} m` : ''}`));
  } else {
    local.append(document.createTextNode('Quem encontrou não compartilhou a localização.'));
  }
  info.append(local);

  const quem = el('p', 'encontro-quem');
  const nome = enc.achador?.nome || 'Pessoa que encontrou';
  quem.append(el('b', null, nome));
  if (enc.achador?.telefone) quem.append(document.createTextNode(' · ' + telefoneBonito(enc.achador.telefone)));
  info.append(quem);
  corpo.append(info);
  c.append(corpo);

  const acoes = el('div', 'encontro-acoes');
  if (enc.lat && enc.lng) {
    const ver = el('button', 'pilula'); ver.type = 'button';
    ver.append(iconeSvg('i-mapa'), document.createTextNode('Ver no mapa'));
    ver.addEventListener('click', () => { irPara('mapa', true); setTimeout(() => map.flyTo([enc.lat, enc.lng], 18), 150); });
    acoes.append(ver, botaoLink('Traçar rota até lá', linkRota(enc.lat, enc.lng), 'i-corre', 'pilula primario'));
  }
  const tel = telefoneWhatsApp(enc.achador?.telefone);
  if (tel.length >= 12) {
    acoes.append(botaoLink('WhatsApp', `https://wa.me/${tel}?text=${encodeURIComponent(`Olá! Sou o tutor de ${nomePet()}. Obrigado por avisar!`)}`, 'i-zap'));
    acoes.append(botaoLink('Ligar', `tel:+${tel}`, null));
  }
  c.append(acoes);

  if (compacto && enc.status === 'resolvido') return c;

  // conversa com quem encontrou (aparece na página do QR, no celular da pessoa)
  const conversa = el('ul', 'encontro-conversa');
  const msgs = [...(enc.mensagem ? [{ de: 'achador', texto: enc.mensagem, em: enc.criadoEm }] : []), ...enc.respostas];
  msgs.forEach((m) => {
    const li = el('li', m.de === 'tutor' ? 'tutor' : 'achador');
    li.append(el('strong', null, m.de === 'tutor' ? 'Você' : nome), el('span', null, m.texto), el('time', null, m.em ? fmtHora(m.em) : ''));
    conversa.append(li);
  });
  if (msgs.length) c.append(conversa);

  if (enc.status !== 'resolvido') {
    const rapidas = el('div', 'encontro-rapidas');
    [['Estou a caminho!', 'a_caminho'], ['Pode ficar com ele mais um pouco?', null], ['Muito obrigado!', null]].forEach(([t, st]) => {
      const b = el('button', 'pilula leve', t); b.type = 'button';
      b.addEventListener('click', () => enviarResposta(enc.id, t, st));
      rapidas.append(b);
    });
    c.append(rapidas);

    const form = el('form', 'encontro-responder');
    const inp = el('input'); inp.maxLength = 400; inp.placeholder = 'Responder a quem encontrou...';
    inp.setAttribute('aria-label', 'Resposta para quem encontrou o pet'); inp.dataset.resposta = enc.id;
    const env = el('button'); env.type = 'submit'; env.setAttribute('aria-label', 'Enviar resposta'); env.append(iconeSvg('i-enviar'));
    form.append(inp, env);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); if (inp.value.trim()) enviarResposta(enc.id, inp.value.trim()); });
    c.append(form);

    const ok = el('button', 'pilula ok-btn'); ok.type = 'button';
    ok.append(iconeSvg('i-check'), document.createTextNode(`${nomePet()} está comigo: encerrar`));
    ok.addEventListener('click', () => petRecuperado(enc.id));
    c.append(ok);
  }
  return c;
}

async function enviarResposta(id, texto, novoStatus) {
  try {
    await responder(id, 'tutor', texto);
    if (novoStatus) await atualizarEncontro(id, { status: novoStatus });
  } catch (err) { mostrarAviso('Não foi possível responder: ' + err.message, null, null, 5000); }
}

function petRecuperado() { return marcarEncontrado(); }

function renderEncontros() {
  // guarda o que o tutor estava digitando para não perder ao atualizar
  const rascunhos = {};
  document.querySelectorAll('input[data-resposta]').forEach((i) => { if (i.value) rascunhos[i.dataset.resposta] = i.value; });
  const foco = document.activeElement?.dataset?.resposta;

  const abertos = encontros.filter((e) => e.status !== 'resolvido');
  $('encontrosInicio').hidden = !abertos.length;
  $('listaEncontrosInicio').replaceChildren(...abertos.slice(0, 2).map((e) => cartaoEncontro(e, false)));
  $('listaEncontros').replaceChildren(...(encontros.length
    ? encontros.slice(0, 10).map((e) => cartaoEncontro(e, true))
    : [el('p', 'dica', 'Nenhum encontro registrado. Quando alguém escanear o QR e avisar, aparece aqui com o ponto exato no mapa.')]));

  document.querySelectorAll('input[data-resposta]').forEach((i) => {
    if (rascunhos[i.dataset.resposta]) i.value = rascunhos[i.dataset.resposta];
    if (foco && i.dataset.resposta === foco && !document.activeElement?.dataset?.resposta) i.focus();
  });
  desenharEncontrosNoMapa();
  aplicarPerfil();           // o status do pet muda para "Pet encontrado" (ou volta) junto com os encontros
}

// pins azuis: o ponto exato de onde a pessoa avisou pelo QR
function desenharEncontrosNoMapa() {
  camadaAchados.clearLayers();
  encontros.filter((e) => e.lat && e.lng).slice(0, 15).forEach((enc) => {
    const pop = el('div', 'pop-encontro');
    pop.append(el('b', null, enc.status === 'resolvido' ? 'Encontro encerrado' : `Alguém encontrou ${nomePet()}`),
      el('div', null, fmtTempo(enc.criadoEm)),
      el('div', null, [ESTADO_PET[enc.estadoPet], ONDE_FICA[enc.ondeFica]].filter(Boolean).join(' · ')));
    if (enc.precisao) pop.append(el('div', null, `Precisão de ~${enc.precisao} m`));
    const rota = el('a', null, 'Traçar rota até lá'); rota.href = linkRota(enc.lat, enc.lng); rota.target = '_blank'; rota.rel = 'noopener';
    pop.append(rota);
    L.marker([enc.lat, enc.lng], {
      zIndexOffset: 900, opacity: enc.status === 'resolvido' ? 0.55 : 1,
      icon: L.divIcon({ className: '', html: `<div class="mk-achado ${enc.status !== 'resolvido' ? 'novo' : ''}"><svg><use href="#i-olho"/></svg></div>`, iconSize: [40, 40], iconAnchor: [20, 40], popupAnchor: [0, -38] })
    }).bindPopup(pop).addTo(camadaAchados);
    if (enc.precisao && enc.status !== 'resolvido') {
      L.circle([enc.lat, enc.lng], { radius: enc.precisao, color: '#1971c2', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(camadaAchados);
    }
  });
}

// ============================================================ conta e vínculo da coleira
function mostrarConta(email) {
  $('contaLateral').hidden = false;
  $('contaEmail').textContent = email;
}
$('btnSair').addEventListener('click', () => sair());

function mostrarVinculo(uid) {
  $('cartaoVincular').hidden = false;
  $('uidColeira').value = uid || '';
  $('statusVincular').textContent = uid ? 'Coleira vinculada. Só ela (e você) gravam os dados do pet.' : 'Nenhuma coleira vinculada ainda.';
  $('statusVincular').className = 'qr-status ' + (uid ? 'ok' : '');
}
$('formVincular').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const uid = $('uidColeira').value.trim();
  if (uid && !/^[A-Za-z0-9]{20,128}$/.test(uid)) {
    $('statusVincular').textContent = 'Esse UID não parece certo. Copie a linha "UID DA COLEIRA" do Monitor Serial.';
    $('statusVincular').className = 'qr-status erro';
    return;
  }
  try {
    await fs.updateDoc(fs.doc(db, 'acesso', PET_ID), { coleira: uid || null });
    mostrarVinculo(uid);
  } catch (err) {
    $('statusVincular').textContent = 'Não foi possível vincular: ' + err.message;
    $('statusVincular').className = 'qr-status erro';
  }
});

// ============================================================ rede do bairro
const CHAVE_DESC = 'bz-desc-' + PET_ID;
async function iniciarComunidadePainel() {
  try {
    comunidade = await montarComunidade($('comunidade'), {
      pet: {
        id: PET_ID,
        nome: nomePet,
        foto: () => perfil.foto || '',
        perdido: () => !!perfil.perdido,
        posicao: () => saida || (ultimoEstado?.lat ? ultimoEstado : areaAtual()),
        descricao: () => { try { return localStorage.getItem(CHAVE_DESC) || ''; } catch { return ''; } },
        salvarDescricao: (d) => { try { if (d != null) localStorage.setItem(CHAVE_DESC, d); } catch { /* ok */ } }
      },
      area: areaAtual(),
      avisar: (texto, confirmacao) => {
        if (!confirmacao) avisar(texto);
        mostrarAviso(texto, confirmacao ? null : 'Ver', confirmacao ? null : () => irPara('comunidade', true), 8000);
      },
      aoContar: (n) => { $('seloBairro').hidden = !n; $('seloBairro').textContent = n; }
    });
  } catch (err) {
    console.error(err);
    $('comunidade').innerHTML = '';
    const p = document.createElement('p'); p.className = 'dica erro';
    p.textContent = 'Não foi possível abrir a rede do bairro: ' + err.message;
    $('comunidade').append(p);
  }
}
// modo perdido ligado/desligado: publica (se o tutor marcou) ou encerra o alerta do bairro
function sincronizarAlertaBairro(perdido) {
  comunidade?.sincronizarPerdido(perdido).catch((err) => console.error('bairro', err));
}

// ============================================================ navegação (barra lateral)
const SECOES = ['inicio', 'mapa', 'saude', 'alertas', 'perdido', 'comunidade', 'testes'];
let secaoAtual = null, mapaJaAberto = false;

function irPara(sec, novaEntrada = false) {
  if (!SECOES.includes(sec)) sec = 'inicio';
  if (location.hash.slice(1) !== sec) {
    if (novaEntrada) { location.hash = sec; return; }              // o hashchange chama de novo
    history.replaceState(null, '', '#' + sec);
  }
  const mudou = secaoAtual !== sec;
  secaoAtual = sec;
  SECOES.forEach((s) => { $('sec-' + s).hidden = s !== sec; });
  document.querySelectorAll('.nav-item').forEach((a) => {
    const ativo = a.dataset.secao === sec;
    a.classList.toggle('ativo', ativo);
    if (ativo) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('tituloMovel').textContent = $('sec-' + sec).dataset.titulo;
  fecharMenu();
  if (sec === 'mapa') {
    requestAnimationFrame(() => {
      map.invalidateSize();
      if (!mapaJaAberto) { mapaJaAberto = true; const a = areaAtual(); map.setView(ultimoEstado?.lat ? [ultimoEstado.lat, ultimoEstado.lng] : [a.lat, a.lng], 17); }
    });
  } else if (movendoCasa) definirMovendo(false);
  if (sec === 'alertas') marcarAlertasLidos();
  if (mudou) {
    window.scrollTo({ top: 0 });
    $('sec-' + sec).focus({ preventScroll: true });
    $('aviso').hidden = true; acaoAviso = null;     // o aviso flutuante não acompanha a troca de tela
  }
}
window.addEventListener('hashchange', () => irPara(location.hash.slice(1)));

function abrirMenu() {
  document.body.classList.add('menu-aberto');
  $('fundoMenu').hidden = false;
  $('btnMenu').setAttribute('aria-expanded', 'true');
  document.querySelector('.nav-item.ativo, .nav-item')?.focus();
}
function fecharMenu() {
  if (!document.body.classList.contains('menu-aberto')) return;
  document.body.classList.remove('menu-aberto');
  $('fundoMenu').hidden = true;
  $('btnMenu').setAttribute('aria-expanded', 'false');
}
$('btnMenu').addEventListener('click', abrirMenu);
$('fundoMenu').addEventListener('click', fecharMenu);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') fecharMenu(); });

// ============================================================ conexão
function definirConexao(texto, classe) {
  document.querySelectorAll('[data-conexao]').forEach((el) => {
    el.className = 'conexao ' + classe + (el.classList.contains('compacta') ? ' compacta' : '');
    el.title = texto;
    el.querySelector('[data-conexao-texto]').textContent = texto;
  });
}

// Garante que esta conta é a dona do pet. Na primeira vez, registra o dono.
async function garantirAcesso(c, user) {
  const ref = c.fs.doc(c.db, 'acesso', PET_ID);
  const snap = await c.fs.getDoc(ref);
  if (!snap.exists()) {
    await c.fs.setDoc(ref, { dono: user.uid, coleira: null, criadoEm: c.fs.serverTimestamp() });
    return { dono: user.uid, coleira: null };
  }
  return snap.data();
}

async function conectarFirebase() {
  const c = await abrirFirestore();
  definirConexao('Entrar', 'simulacao');
  const user = await exigirLogin({
    titulo: 'Painel da coleira',
    texto: `Entre para ver ${PET_NOME}. Os dados da coleira (posição, saúde e alertas) são privados: só você e a coleira acessam.`
  });
  let acesso;
  try { acesso = await garantirAcesso(c, user); }
  catch (err) {
    console.error(err);
    definirConexao('Sem acesso', 'erro');
    $('status').textContent = `Esta conta (${user.email}) não é a dona de "${PET_ID}". Entre com a conta que cadastrou o pet.`;
    mostrarConta(user.email);
    return;
  }
  fs = c.fs; db = c.db;
  mostrarConta(user.email);
  mostrarVinculo(acesso.coleira);
  iniciarEncontros().then(() => ouvirEncontros((lista) => { encontros = lista; renderEncontros(); }));
  iniciarComunidadePainel();

  fs.onSnapshot(fs.doc(db, 'perfis', PET_ID), (snap) => {
    const d = snap.exists() ? snap.data() : {};
    perfil = { ...PERFIL_PADRAO, ...d, perdidoDesde: paraData(d.perdidoDesde) };
    aplicarPerfil();
  }, (err) => console.error('perfil', err));

  fs.onSnapshot(fs.doc(db, 'pets', PET_ID), (snap) => {
    definirConexao('Sincronizado', 'ao-vivo');
    if (!snap.exists()) { $('status').textContent = 'Nenhum dado da coleira ainda. Ligue a coleira ou use a área de testes.'; return; }
    const d = snap.data();
    renderEstado({ ...d, atualizadoEm: paraData(d.atualizadoEm) || new Date() });
  }, (err) => {
    console.error(err);
    definirConexao('Erro no Firebase', 'erro');
    $('status').textContent = 'Erro ao ler o Firebase: ' + err.message;
  });

  fs.onSnapshot(fs.doc(db, 'pets', PET_ID, 'config', 'area'), (snap) => {
    if (!snap.exists()) return;
    const d = snap.data();
    area = { lat: d.lat, lng: d.lng, raio: d.raio };
    desenharArea();                 // um rascunho em andamento continua sendo mostrado
  });

  // resumos diários dos últimos 14 dias (id = AAAA-MM-DD: dá para filtrar pelo id, sem índice extra)
  const qSaude = fs.query(fs.collection(db, 'pets', PET_ID, 'saude'),
    fs.where(fs.documentId(), '>=', dataLocal(diasAtras(14))));
  fs.onSnapshot(qSaude, (snap) => {
    diasSaude = {};
    snap.docs.forEach((d) => { const x = d.data(); if (x.data) diasSaude[x.data] = normalizarDia(x); });
    renderSaude();
  }, (err) => console.error('saude', err));

  const q = fs.query(fs.collection(db, 'pets', PET_ID, 'alertas'), fs.orderBy('criadoEm', 'desc'), fs.limit(40));
  fs.onSnapshot(q, (snap) => {
    const lista = snap.docs.map((d) => ({ ...d.data(), id: d.id, data: paraData(d.data().criadoEm) }))
      .filter((a) => !a.pet || a.pet === PET_ID);
    renderAlertas(lista);
  });
}

// atualiza "há X s" e detecta coleira sem sinal
setInterval(() => { if (ultimoEstado) renderEstado(ultimoEstado, false); }, 5000);
new ResizeObserver(() => { map.invalidateSize(); desenharBpm(); }).observe($('map'));

if (!configurado) {
  carregarSaudeLocal();
  iniciarEncontros().then(() => ouvirEncontros((lista) => { encontros = lista; renderEncontros(); }));
  iniciarComunidadePainel();
}
irPara(location.hash.slice(1) || 'inicio');
aplicarPerfil();
desenharQR();
renderSaude();
if (!configurado) renderAlertasLocais(); else renderAlertas([]);
desenharArea();
if (configurado) {
  conectarFirebase().catch((err) => {
    console.error(err);
    definirConexao('Sem Firebase: simulação', 'erro');
    db = null; carregarSaudeLocal(); renderSaude(); ligarSimulador();
  });
} else {
  definirConexao('Modo simulação', 'simulacao');
  ligarSimulador();
}
