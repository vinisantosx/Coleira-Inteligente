// Encontros: quando alguém acha o pet e avisa pelo QR da coleira.
//
// Firestore  pets/{pet}/encontros/{id}:
//   autor (uid anônimo de quem achou), pet, criadoEm, lat, lng, precisao, mapaEm (quando a localização foi pega),
//   achador {nome, telefone}, mensagem, estadoPet, ondeFica, foto,
//   status: 'aberto' | 'a_caminho' | 'resolvido',
//   respostas: [{de: 'tutor' | 'achador', texto, em}]
//
// Sem Firebase (simulação) tudo fica no localStorage: o painel e a página do QR
// abertos em abas do mesmo navegador conversam entre si.
import { PET_ID } from './firebase-config.js';
import { configurado, abrirFirestore, entrarAnonimo, perfilLocal, salvarPerfilLocal, CHAVE_PERFIL } from './perfil-dados.js';
import { ACHADOR_SIMULACAO } from './selos.js';

const CHAVE = 'coleira-encontros-' + PET_ID;
const EVENTO = 'encontros-mudou';
let conn = null;

const col = (fs, db) => fs.collection(db, 'pets', PET_ID, 'encontros');
const ref = (fs, db, id) => fs.doc(db, 'pets', PET_ID, 'encontros', id);
const lerLocal = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || {}; } catch { return {}; } };
function gravarLocal(todos) {
  try { localStorage.setItem(CHAVE, JSON.stringify(todos)); } catch { throw new Error('o navegador não deixou salvar'); }
  window.dispatchEvent(new Event(EVENTO));          // a mesma aba também precisa saber
}
const paraData = (v) => (!v ? null : v.toDate ? v.toDate() : new Date(v));
const normalizar = (id, d) => ({
  ...d, id,
  criadoEm: paraData(d.criadoEm),
  mapaEm: paraData(d.mapaEm),
  respostas: (d.respostas || []).map((r) => ({ ...r, em: paraData(r.em) })).sort((a, b) => a.em - b.em)
});

export async function iniciarEncontros() {
  if (configurado && !conn) {
    try { conn = await abrirFirestore(); } catch (err) { console.error(err); conn = null; }
  }
  return !!conn;
}

export async function criarEncontro(dados) {
  const base = { ...dados, pet: PET_ID, status: 'aberto', respostas: [] };
  if (conn) {
    const { fs, db } = conn;
    const eu = conn.auth.currentUser || await entrarAnonimo();
    const r = await fs.addDoc(col(fs, db), {
      ...base, autor: eu.uid, criadoEm: fs.serverTimestamp(), mapaEm: dados.lat ? fs.serverTimestamp() : null
    });
    return r.id;
  }
  const id = 'enc_' + Date.now().toString(36);
  const todos = lerLocal();
  todos[id] = { ...base, autor: ACHADOR_SIMULACAO, criadoEm: new Date().toISOString(), mapaEm: dados.lat ? new Date().toISOString() : null };
  gravarLocal(todos);
  return id;
}

export async function atualizarEncontro(id, patch) {
  if (conn) {
    const { fs, db } = conn;
    const extra = patch.lat ? { mapaEm: fs.serverTimestamp() } : {};
    await fs.updateDoc(ref(fs, db, id), { ...patch, ...extra });
    return;
  }
  const todos = lerLocal();
  if (!todos[id]) throw new Error('encontro não encontrado');
  todos[id] = { ...todos[id], ...patch, ...(patch.lat ? { mapaEm: new Date().toISOString() } : {}) };
  gravarLocal(todos);
}

export async function responder(id, de, texto) {
  const r = { de, texto: String(texto).slice(0, 400), em: new Date().toISOString() };
  if (conn) {
    const { fs, db } = conn;
    await fs.updateDoc(ref(fs, db, id), { respostas: fs.arrayUnion(r) });
    return;
  }
  const todos = lerLocal();
  if (!todos[id]) throw new Error('encontro não encontrado');
  todos[id].respostas = [...(todos[id].respostas || []), r];
  gravarLocal(todos);
}

// um encontro só (página do QR acompanhando a resposta do tutor)
export function ouvirEncontro(id, cb) {
  if (conn) {
    const { fs, db } = conn;
    return fs.onSnapshot(ref(fs, db, id), (s) => cb(s.exists() ? normalizar(s.id, s.data()) : null),
      (err) => { console.error('encontro', err); cb(null); });
  }
  const enviar = () => { const d = lerLocal()[id]; cb(d ? normalizar(id, d) : null); };
  const aoMudar = (e) => { if (!e.key || e.key === CHAVE) enviar(); };
  window.addEventListener('storage', aoMudar);
  window.addEventListener(EVENTO, enviar);
  enviar();
  return () => { window.removeEventListener('storage', aoMudar); window.removeEventListener(EVENTO, enviar); };
}

// todos os encontros do pet (painel do tutor), do mais novo para o mais antigo
export function ouvirEncontros(cb) {
  if (conn) {
    const { fs, db } = conn;
    const q = fs.query(col(fs, db), fs.orderBy('criadoEm', 'desc'), fs.limit(20));
    return fs.onSnapshot(q, (snap) => cb(snap.docs.map((d) => normalizar(d.id, d.data()))),
      (err) => console.error('encontros', err));
  }
  const enviar = () => cb(Object.entries(lerLocal()).map(([id, d]) => normalizar(id, d)).sort((a, b) => b.criadoEm - a.criadoEm));
  const aoMudar = (e) => { if (!e.key || e.key === CHAVE) enviar(); };
  window.addEventListener('storage', aoMudar);
  window.addEventListener(EVENTO, enviar);
  enviar();
  return () => { window.removeEventListener('storage', aoMudar); window.removeEventListener(EVENTO, enviar); };
}

// Quem achou confirma no perfil público que o pet foi encontrado. Só vai o id do
// encontro e a hora: nome e telefone de quem achou ficam visíveis apenas para o tutor.
export async function marcarNoPerfil(id) {
  if (conn) {
    const { fs, db } = conn;
    await fs.updateDoc(fs.doc(db, 'perfis', PET_ID), { encontrado: { encontroId: id, em: fs.serverTimestamp() } });
    return;
  }
  salvarPerfilLocal({ ...perfilLocal(), encontrado: { encontroId: id, em: new Date().toISOString() } });
  window.dispatchEvent(new StorageEvent('storage', { key: CHAVE_PERFIL }));
}

export const linkRota = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
export const ESTADO_PET = { bem: 'Está bem', assustado: 'Assustado', machucado: 'Parece machucado' };
export const ONDE_FICA = { comigo: 'Está comigo', no_local: 'Ficou onde encontrei', levei: 'Levei para outro lugar' };
export const STATUS = { aberto: 'Aguardando o tutor', a_caminho: 'Tutor a caminho', resolvido: 'Pet recuperado' };
