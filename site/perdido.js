// Página aberta por quem escaneia o QR da coleira.
// Quem encontrou o pet registra o encontro (localização exata do celular dele,
// como o pet está, onde ele vai ficar, foto) e conversa com o tutor por aqui.
import { PET_ID } from './firebase-config.js';
import {
  configurado, abrirFirestore, perfilLocal, adicionarAvistamentoLocal, PERFIL_PADRAO,
  telefoneWhatsApp, telefoneBonito, CHAVE_PERFIL, reduzirFoto
} from './perfil-dados.js';
import { iniciarEncontros, criarEncontro, atualizarEncontro, responder, ouvirEncontro, marcarNoPerfil, STATUS } from './encontros.js';

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
  document.title = perfil.perdido ? `${perfil.nome} está perdido!` : `Encontrou ${perfil.nome}?`;
  $('nome').textContent = perfil.nome;
  document.querySelectorAll('[data-nome]').forEach((el) => { el.textContent = perfil.nome; });
  const jaAvisado = !!perfil.encontrado;
  document.body.dataset.perdido = String(!!perfil.perdido && !jaAvisado);
  $('faixa').hidden = !perfil.perdido || jaAvisado;
  $('faixaEncontrado').hidden = !jaAvisado;
  $('intro').textContent = jaAvisado
    ? 'Alguém já avisou meu tutor que me encontrou e ele está vindo me buscar. Se eu estiver com você, avise também por aqui.'
    : perfil.perdido
      ? 'Meu tutor está me procurando. Se você me encontrou, avise ele por esta página.'
      : 'Esta é a minha coleira inteligente. Se eu estiver sozinho por aí, avise meu tutor.';

  if (perfil.foto) { $('foto').src = perfil.foto; $('foto').alt = `Foto de ${perfil.nome}`; }
  $('foto').hidden = !perfil.foto;
  $('fotoPadrao').style.display = perfil.foto ? 'none' : '';

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
    ? `${perfil.nome} está em segurança. Muito obrigado!`
    : 'Obrigado! O tutor foi avisado.';
  $('formResposta').hidden = resolvido;
  $('btnAtualizarLocal').hidden = resolvido;

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
