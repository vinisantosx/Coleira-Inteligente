// Página aberta por quem escaneia o QR da coleira.
// Quem encontrou o pet registra o encontro (localização exata do celular dele,
// como o pet está, onde ele vai ficar, foto) e conversa com o tutor por aqui.
import { PET_ID } from './firebase-config.js';
import {
  configurado, abrirFirestore, perfilLocal, adicionarAvistamentoLocal, PERFIL_PADRAO,
  telefoneWhatsApp, telefoneBonito, CHAVE_PERFIL, reduzirFoto
} from './perfil-dados.js';
import { iniciarEncontros, criarEncontro, atualizarEncontro, responder, ouvirEncontro, marcarNoPerfil, STATUS } from './encontros.js';
import { iniciarSelos, reconhecimentosDe, calcularSelos, seloPorId, aoMudarSelos } from './selos.js';

const $ = (id) => document.getElementById(id);
const pet = new URLSearchParams(location.search).get('pet') || PET_ID;
const CHAVE_MEU = 'meu-encontro-' + pet;     // este celular já avisou o tutor
let perfil = { ...PERFIL_PADRAO };
let posicao = null;
let foto = '';
let conexao = null;
let encontroId = null;

const linkMapa = (lat, lng) => `https://maps.google.com/?q=${lat},${lng}`;
const valorRadio = (nome) => document.querySelector(`input[name="${nome}"]:checked`)?.value || '';

function mostrarPerfil(p) {
  perfil = { ...PERFIL_PADRAO, ...p };
  document.body.dataset.perdido = String(!!perfil.perdido);
  document.title = perfil.perdido ? `${perfil.nome} está perdido!` : `Encontrou ${perfil.nome}? | Vitalar`;
  $('nome').textContent = perfil.nome;
  document.querySelectorAll('[data-nome]').forEach((el) => { el.textContent = perfil.nome; });
  const jaAvisado = !!perfil.encontrado;
  document.body.dataset.perdido = String(!!perfil.perdido && !jaAvisado);
  $('faixa').hidden = !perfil.perdido || jaAvisado;
  $('faixaEncontrado').hidden = !jaAvisado;
  $('intro').textContent = jaAvisado
    ? 'Alguém já avisou o tutor que encontrou este pet. Se ele estiver com você, avise também por aqui.'
    : perfil.perdido
      ? 'O tutor está procurando por ele. Se você o encontrou, avise por esta página.'
      : 'Este pet usa uma coleira com localização. Se ele estiver sozinho, avise o tutor.';

  if (perfil.foto) { $('foto').src = perfil.foto; $('foto').alt = `Foto de ${perfil.nome}`; }
  $('foto').hidden = !perfil.foto;
  $('fotoPadrao').style.display = perfil.foto ? 'none' : '';
  // sem foto: o mascote da espécie (cão ou gato) ou a inicial do nome
  const ava = $('fotoPadrao').querySelector('[data-inicial]');
  const m = { cao: 'i-cao', gato: 'i-gato' }[perfil.especie || 'cao'];
  if (m) ava.innerHTML = `<svg class="mascote" viewBox="0 0 120 120" aria-hidden="true"><use href="#${m}"/></svg>`;
  else ava.textContent = (perfil.nome || '?').charAt(0).toUpperCase();
  // espécie, raça, porte e cor ajudam a confirmar que é o pet certo
  const PORTE = { pequeno: 'porte pequeno', medio: 'porte médio', grande: 'porte grande' };
  const ESPECIE = { cao: 'Cão', gato: 'Gato' };
  const sobre = [ESPECIE[perfil.especie] || '', perfil.raca, PORTE[perfil.porte], perfil.cor].filter(Boolean).join(', ');
  $('sobre').hidden = !sobre;
  $('sobre').textContent = sobre;
  $('caixaCuidados').hidden = !perfil.cuidados;
  $('cuidados').textContent = perfil.cuidados || '';

  $('caixaRecado').hidden = !perfil.recado;
  $('recado').textContent = perfil.recado || '';

  const tel = telefoneWhatsApp(perfil.telefone);
  $('contatos').hidden = !tel;
  if (tel) {
    $('lnkTel').href = `tel:+${tel}`;
    $('telTexto').textContent = `Ligar ${telefoneBonito(perfil.telefone)}`;
    atualizarZap();
  }
}

function atualizarZap() {
  const tel = telefoneWhatsApp(perfil.telefone);
  if (!tel) return;
  let txt = `Olá! Encontrei ${perfil.nome} pelo QR da coleira.`;
  if (posicao) txt += ` Ele está aqui: ${linkMapa(posicao.lat, posicao.lng)}`;
  $('lnkZap').href = `https://wa.me/${tel}?text=${encodeURIComponent(txt)}`;
}

function status(id, texto, tipo = '') {
  $(id).textContent = texto;
  $(id).className = 'qr-status ' + tipo;
}

function pegarLocalizacao() {
  return new Promise((ok, erro) => {
    if (!('geolocation' in navigator)) return erro(new Error('Este navegador não informa a localização.'));
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), precisao: Math.round(p.coords.accuracy) }),
      (e) => erro(new Error(e.code === 1 ? 'Você não permitiu o acesso à localização.' : 'Não consegui obter a localização.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// ---------- foto opcional ----------
$('finderFoto').addEventListener('change', async () => {
  const arq = $('finderFoto').files[0];
  if (!arq) return;
  try {
    foto = await reduzirFoto(arq, 480);
    $('fotoPrev').src = foto;
    $('fotoPrev').hidden = false;
    $('fotoTexto').textContent = 'Trocar a foto';
  } catch (err) { status('statusEnvio', err.message, 'erro'); }
});

// ---------- registrar o encontro ----------
async function registrarAlerta(dados, id) {
  const aviso = {
    pet, tipo: 'avistamento', encontroId: id,
    mensagem: `${perfil.nome} foi encontrado por ${dados.achador.nome || 'uma pessoa'} (pelo QR)${dados.mensagem ? `: "${dados.mensagem}"` : ''}`,
    lat: dados.lat ?? null, lng: dados.lng ?? null, precisao: dados.precisao ?? null,
    contatoNome: dados.achador.nome, contatoTelefone: dados.achador.telefone
  };
  if (conexao) {
    const { fs, db } = conexao;
    await fs.addDoc(fs.collection(db, 'pets', pet, 'alertas'), { ...aviso, criadoEm: fs.serverTimestamp() });
  } else {
    adicionarAvistamentoLocal({ ...aviso, data: new Date().toISOString() });
  }
}

async function enviar(comLocalizacao) {
  $('btnEnviar').disabled = true;
  $('btnSemLocal').hidden = true;
  try {
    if (comLocalizacao) {
      status('statusEnvio', 'Pegando sua localização...');
      posicao = await pegarLocalizacao();
    }
    status('statusEnvio', 'Avisando o tutor...');
    const dados = {
      lat: posicao?.lat ?? null, lng: posicao?.lng ?? null, precisao: posicao?.precisao ?? null,
      achador: { nome: $('finderNome').value.trim(), telefone: $('finderTel').value.trim() },
      mensagem: $('finderMsg').value.trim(),
      estadoPet: valorRadio('estadoPet'), ondeFica: valorRadio('ondeFica'),
      foto
    };
    const id = await criarEncontro(dados);
    // status do pet passa a "encontrado" (painel do tutor e quem escanear depois)
    await Promise.all([registrarAlerta(dados, id), marcarNoPerfil(id)]);
    try { localStorage.setItem(CHAVE_MEU, id); } catch { /* ok */ }
    atualizarZap();
    abrirConversa(id);
  } catch (err) {
    console.error(err);
    status('statusEnvio', err.message, 'erro');
    $('btnEnviar').disabled = false;
    if (comLocalizacao) $('btnSemLocal').hidden = false;
  }
}

$('btnEnviar').addEventListener('click', () => enviar(true));
$('btnSemLocal').addEventListener('click', () => enviar(false));

// ---------- selo de boa ação (o tutor agradece pela plataforma) ----------
let meuAutor = null, esperaSelo = null;
async function mostrarSelo() {
  if (!meuAutor) return;
  await iniciarSelos();
  let lista = [];
  try { lista = (await reconhecimentosDe([meuAutor]))[meuAutor] || []; } catch (err) { console.error('selos', err); return; }
  const daqui = lista.find((r) => r.pet === pet && r.origem === 'encontro');
  const caixa = $('seloAchador');
  if (!daqui) {
    // o tutor costuma agradecer logo depois de encerrar: confere de novo em 30 s
    clearTimeout(esperaSelo); esperaSelo = setTimeout(mostrarSelo, 30000);
    caixa.hidden = true;
    return;
  }
  const info = calcularSelos(lista);
  const selo = daqui.tipo === 'devolveu' ? seloPorId('anjo') : info.principal || seloPorId('olhar');
  caixa.className = 'qr-selo selo-' + selo.id;
  caixa.innerHTML = '';
  const disco = document.createElement('span'); disco.className = 'selo-disco';
  disco.innerHTML = `<svg aria-hidden="true"><use href="#${selo.icone}"/></svg>`;
  const txt = document.createElement('div');
  const t1 = document.createElement('p'); t1.innerHTML = '<b></b>';
  t1.firstChild.textContent = daqui.tipo === 'devolveu'
    ? `O tutor agradeceu por você devolver ${perfil.nome}: você ganhou o selo ${selo.nome}.`
    : `O tutor agradeceu a sua ajuda: selo ${selo.nome}.`;
  const t2 = document.createElement('p'); t2.className = 'dica';
  t2.textContent = info.principal && info.principal.id !== selo.id
    ? `Seu selo principal é ${info.principal.nome} (${info.familias} famílias ajudadas).`
    : 'Os vizinhos veem o selo ao lado do seu apelido na rede de alerta do bairro.';
  const t3 = document.createElement('p'); t3.className = 'dica';
  t3.innerHTML = 'Para guardar o selo, <a href="bairro.html">entre na rede do bairro</a> e crie a sua conta neste mesmo celular.';
  txt.append(t1, t2, t3);
  caixa.append(disco, txt);
  caixa.hidden = false;
}
aoMudarSelos(() => { if (meuAutor) mostrarSelo(); });

// ---------- conversa com o tutor ----------
let pararDeOuvir = null;
function abrirConversa(id) {
  encontroId = id;
  $('acao').hidden = true;
  $('conversa').hidden = false;
  if (pararDeOuvir) pararDeOuvir();
  pararDeOuvir = ouvirEncontro(id, mostrarConversa);
}

function mostrarConversa(enc) {
  if (!enc) {          // encontro apagado ou de outro navegador
    try { localStorage.removeItem(CHAVE_MEU); } catch { /* ok */ }
    $('conversa').hidden = true; $('acao').hidden = false; $('btnEnviar').disabled = false;
    return;
  }
  const resolvido = enc.status === 'resolvido';
  $('situacao').textContent = STATUS[enc.status] || STATUS.aberto;
  $('situacao').className = 'qr-situacao ' + enc.status;
  $('conversaTitulo').textContent = resolvido
    ? `${perfil.nome} já está com o tutor. Obrigado pela ajuda.`
    : 'O tutor foi avisado.';
  $('formResposta').hidden = resolvido;
  $('btnAtualizarLocal').hidden = resolvido;
  meuAutor = enc.autor || null;
  if (resolvido) mostrarSelo(); else $('seloAchador').hidden = true;

  const ul = $('mensagens');
  ul.replaceChildren();
  const itens = [
    ...(enc.mensagem ? [{ de: 'achador', texto: enc.mensagem, em: enc.criadoEm }] : []),
    ...enc.respostas
  ];
  if (!itens.length) {
    const li = document.createElement('li'); li.className = 'vazio';
    li.textContent = 'Quando o tutor responder, a mensagem aparece aqui.';
    ul.append(li);
  }
  for (const m of itens) {
    const li = document.createElement('li');
    li.className = m.de === 'tutor' ? 'tutor' : 'eu';
    const quem = document.createElement('strong'); quem.textContent = m.de === 'tutor' ? 'Tutor' : 'Você';
    const txt = document.createElement('span'); txt.textContent = m.texto;
    const quando = document.createElement('time');
    quando.textContent = m.em ? m.em.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
    li.append(quem, txt, quando);
    ul.append(li);
  }
}

$('formResposta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const texto = $('resposta').value.trim();
  if (!texto || !encontroId) return;
  try {
    await responder(encontroId, 'achador', texto);
    $('resposta').value = '';
    status('statusConversa', '');
  } catch (err) { status('statusConversa', 'Não foi possível enviar: ' + err.message, 'erro'); }
});

$('btnAtualizarLocal').addEventListener('click', async () => {
  try {
    status('statusConversa', 'Pegando sua localização...');
    posicao = await pegarLocalizacao();
    await atualizarEncontro(encontroId, { lat: posicao.lat, lng: posicao.lng, precisao: posicao.precisao });
    await responder(encontroId, 'achador', 'Atualizei minha localização no mapa.');
    atualizarZap();
    status('statusConversa', 'Localização atualizada.', 'ok');
  } catch (err) { status('statusConversa', err.message, 'erro'); }
});

// ---------- iniciar ----------
async function iniciar() {
  if (await iniciarEncontros()) {
    try {
      conexao = await abrirFirestore();
      const { fs, db } = conexao;
      fs.onSnapshot(fs.doc(db, 'perfis', pet), (snap) => mostrarPerfil(snap.exists() ? snap.data() : {}),
        (err) => { console.error(err); mostrarPerfil(perfilLocal()); });
    } catch (err) { console.error(err); conexao = null; mostrarPerfil(perfilLocal()); }
  } else {
    mostrarPerfil(perfilLocal());
    window.addEventListener('storage', (e) => { if (e.key === CHAVE_PERFIL) mostrarPerfil(perfilLocal()); });
  }
  let meu = null;
  try { meu = localStorage.getItem(CHAVE_MEU); } catch { /* ok */ }
  if (meu) abrirConversa(meu);
}
iniciar();
