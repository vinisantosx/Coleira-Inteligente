// Página aberta por quem escaneia o QR da coleira.
import { PET_ID } from './firebase-config.js';
import {
  configurado, abrirFirestore, perfilLocal, adicionarAvistamentoLocal, PERFIL_PADRAO,
  telefoneWhatsApp, telefoneBonito, CHAVE_PERFIL
} from './perfil-dados.js';

const $ = (id) => document.getElementById(id);
const pet = new URLSearchParams(location.search).get('pet') || PET_ID;
let perfil = { ...PERFIL_PADRAO };
let posicao = null;
let conexao = null;

const linkMapa = (lat, lng) => `https://maps.google.com/?q=${lat},${lng}`;

function mostrarPerfil(p) {
  perfil = { ...PERFIL_PADRAO, ...p };
  document.body.dataset.perdido = String(!!perfil.perdido);
  document.title = perfil.perdido ? `${perfil.nome} está perdido!` : `Encontrou ${perfil.nome}?`;
  $('nome').textContent = perfil.nome;
  $('faixa').hidden = !perfil.perdido;
  $('intro').textContent = perfil.perdido
    ? `Meu tutor está me procurando. Se você me encontrou, toque no botão abaixo para enviar onde eu estou.`
    : `Esta é a minha coleira inteligente. Se eu estiver sozinho por aí, avise meu tutor.`;

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

function status(texto, tipo = '') {
  $('statusEnvio').textContent = texto;
  $('statusEnvio').className = 'qr-status ' + tipo;
}

function pegarLocalizacao() {
  return new Promise((ok, erro) => {
    if (!('geolocation' in navigator)) return erro(new Error('Este navegador não informa a localização.'));
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), precisao: Math.round(p.coords.accuracy) }),
      (e) => erro(new Error(e.code === 1 ? 'Você não permitiu o acesso à localização.' : 'Não consegui obter a localização.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
}

async function enviar(comLocalizacao) {
  $('btnEnviar').disabled = true;
  $('btnSemLocal').hidden = true;
  try {
    if (comLocalizacao) {
      status('Pegando sua localização...');
      posicao = await pegarLocalizacao();
    }
    status('Avisando o tutor...');
    const nome = $('finderNome').value.trim(), tel = $('finderTel').value.trim(), msg = $('finderMsg').value.trim();
    const aviso = {
      pet, tipo: 'avistamento',
      mensagem: `Alguém encontrou ${perfil.nome}${msg ? `: "${msg}"` : ''}`,
      lat: posicao?.lat ?? null, lng: posicao?.lng ?? null, precisao: posicao?.precisao ?? null,
      contatoNome: nome, contatoTelefone: tel
    };
    if (conexao) {
      const { fs, db } = conexao;
      await fs.addDoc(fs.collection(db, 'alertas'), { ...aviso, criadoEm: fs.serverTimestamp() });
    } else if (!adicionarAvistamentoLocal({ ...aviso, data: new Date().toISOString() })) {
      throw new Error('Não foi possível registrar o aviso neste navegador.');
    }
    atualizarZap();
    $('acao').hidden = true;
    $('sucesso').hidden = false;
  } catch (err) {
    console.error(err);
    status(err.message, 'erro');
    $('btnEnviar').disabled = false;
    if (comLocalizacao) $('btnSemLocal').hidden = false;
  }
}

$('btnEnviar').addEventListener('click', () => enviar(true));
$('btnSemLocal').addEventListener('click', () => enviar(false));

// ---------- carregar o perfil ----------
async function iniciar() {
  if (configurado) {
    try {
      conexao = await abrirFirestore();
      const { fs, db } = conexao;
      fs.onSnapshot(fs.doc(db, 'perfis', pet), (snap) => mostrarPerfil(snap.exists() ? snap.data() : {}),
        (err) => { console.error(err); mostrarPerfil(perfilLocal()); });
      return;
    } catch (err) {
      console.error(err);
      conexao = null;
    }
  }
  mostrarPerfil(perfilLocal());
  window.addEventListener('storage', (e) => { if (e.key === CHAVE_PERFIL) mostrarPerfil(perfilLocal()); });
}
iniciar();
