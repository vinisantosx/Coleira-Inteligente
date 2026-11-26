// Rede de alerta do bairro: dados (Firestore ou simulação local).
//
// Privacidade e segurança (as regras do Firestore garantem o mesmo no servidor):
//   - ninguém vê onde o outro mora: o vizinho guarda só uma quadrícula de ~1 km
//     (celula = canto da quadrícula de 0,01°) e um apelido;
//   - só pets PERDIDOS aparecem, com área aproximada; nunca a posição da coleira;
//   - "vi este pet" guarda o ponto exato, mas só o tutor e quem enviou veem;
//   - o contato com o tutor passa pela página do QR (o tutor decide o que mostrar).
//
// Firestore:
//   vizinhos/{uid}                 apelido, bairro, celula, raio (1-3 km), autoPublicar
//   bairro/{pet}                   pet, nome, foto, descricao, bairro, celula, celulas[], status, desde, encerradoEm
//   bairro/{pet}/ajudantes/{uid}   apelido, em        ("estou procurando")
//   bairro/{pet}/avistamentos/{id} autor, apelido, lat, lng, precisao, nota, em
//   denuncias/{id}                 alvo, motivo, autor, em
import { AREA_PADRAO } from './firebase-config.js';
import { configurado, abrirFirestore } from './perfil-dados.js';

let conn = null;
const EVENTO = 'bairro-mudou';
const CHAVE = 'coleira-bairro';
const EU_LOCAL = 'eu';

// ---------------------------------------------------------------- geografia (quadrícula de ~1,1 km)
const PASSO = 0.01;
const fix2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
export const celulaDe = (lat, lng) => `${fix2(Math.floor(lat / PASSO) * PASSO)}_${fix2(Math.floor(lng / PASSO) * PASSO)}`;
export function centroCelula(c) {
  const [a, b] = String(c).split('_').map(Number);
  return { lat: +(a + PASSO / 2).toFixed(4), lng: +(b + PASSO / 2).toFixed(4) };
}
export function celulasAoRedor(c, n = 3) {
  const [a, b] = String(c).split('_').map(Number);
  const lista = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) lista.push(`${fix2(a + i * PASSO)}_${fix2(b + j * PASSO)}`);
  return lista;
}
export function distanciaKm(p, q) {
  const r = Math.PI / 180, R = 6371;
  const dLat = (q.lat - p.lat) * r, dLng = (q.lng - p.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * r) * Math.cos(q.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const RAIO_AREA_M = 800;          // círculo desenhado para a área aproximada

// ---------------------------------------------------------------- simulação local
const paraData = (v) => (!v ? null : v.toDate ? v.toDate() : new Date(v));
function semente() {
  const c = celulaDe(AREA_PADRAO.lat, AREA_PADRAO.lng);
  const [a, b] = c.split('_').map(Number);
  const vizinha = `${fix2(a + PASSO)}_${fix2(b - PASSO)}`;
  const longe = `${fix2(a - PASSO)}_${fix2(b + 2 * PASSO)}`;
  const h = (horas) => new Date(Date.now() - horas * 3600e3).toISOString();
  const alerta = (pet, nome, celula, descricao, horas, bairro, status = 'ativo') => ({
    pet, nome, foto: '', descricao, bairro, celula, celulas: celulasAoRedor(celula), status, desde: h(horas),
    encerradoEm: status === 'resolvido' ? h(horas - 5) : null, simulado: true
  });
  return {
    vizinho: null,
    alertas: {
      mel: alerta('mel', 'Mel', vizinha, 'Gata tricolor, muito assustada. Não tente pegar no colo, só avise.', 3, 'Centro'),
      thor: alerta('thor', 'Thor', longe, 'Porte grande, caramelo, coleira azul. É dócil.', 20, 'Jardim Flores'),
      nina: alerta('nina', 'Nina', c, 'Pequena, branca.', 80, 'Centro', 'resolvido'),
      bob: alerta('bob', 'Bob', vizinha, 'Vira-lata preto.', 200, 'Centro', 'resolvido')
    },
    ajudantes: { mel: { v1: { apelido: 'Carlos', em: h(2) }, v2: { apelido: 'Dona Lúcia', em: h(1) } }, thor: { v3: { apelido: 'Rafa', em: h(10) } } },
    avistamentos: {}
  };
}
const lerLocal = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || semente(); } catch { return semente(); } };
function gravarLocal(d) {
  try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch { throw new Error('o navegador não deixou salvar'); }
  window.dispatchEvent(new Event(EVENTO));
}
function ouvirLocal(fn) {
  const aoMudar = (e) => { if (!e.key || e.key === CHAVE) fn(lerLocal()); };
  window.addEventListener('storage', aoMudar);
  window.addEventListener(EVENTO, () => fn(lerLocal()));
  fn(lerLocal());
  return () => window.removeEventListener('storage', aoMudar);
}

// ---------------------------------------------------------------- início
export async function iniciarComunidade() {
  if (configurado && !conn) {
    try { conn = await abrirFirestore(); } catch (err) { console.error(err); conn = null; }
  }
  return !!conn;
}
export const emSimulacao = () => !conn;
function meuUid() {
  if (!conn) return EU_LOCAL;
  const u = conn.auth.currentUser;
  if (!u || u.isAnonymous) throw new Error('Entre com a sua conta para usar a rede do bairro.');
  return u.uid;
}

// ---------------------------------------------------------------- participação
export async function lerVizinho() {
  if (!conn) return lerLocal().vizinho;
  const { fs, db } = conn;
  const s = await fs.getDoc(fs.doc(db, 'vizinhos', meuUid()));
  return s.exists() ? s.data() : null;
}
export async function salvarVizinho({ apelido, bairro, celula, raio, autoPublicar = false }) {
  const d = { apelido: apelido.trim().slice(0, 30), bairro: bairro.trim().slice(0, 50), celula, raio: Number(raio), autoPublicar: !!autoPublicar };
  if (!conn) { const t = lerLocal(); t.vizinho = d; gravarLocal(t); return d; }
  const { fs, db } = conn;
  await fs.setDoc(fs.doc(db, 'vizinhos', meuUid()), { ...d, atualizadoEm: fs.serverTimestamp() }, { merge: true });
  return d;
}
export async function sairDaRede(petsQueAjudo = []) {
  if (!conn) {
    const t = lerLocal(); t.vizinho = null;
    Object.values(t.ajudantes).forEach((m) => delete m[EU_LOCAL]);
    gravarLocal(t); return;
  }
  const { fs, db } = conn;
  const uid = meuUid();
  await Promise.all(petsQueAjudo.map((p) => fs.deleteDoc(fs.doc(db, 'bairro', p, 'ajudantes', uid)).catch(() => {})));
  await fs.deleteDoc(fs.doc(db, 'vizinhos', uid));
}

// ---------------------------------------------------------------- alertas perto de mim
const normalizar = (id, d) => ({ ...d, pet: d.pet || id, desde: paraData(d.desde), encerradoEm: paraData(d.encerradoEm) });

// cb({ ativos, recuperados }) — recuperados = últimos 30 dias, para o contador da região
export function ouvirAlertasPerto(celula, cb) {
  const corte = Date.now() - 30 * 864e5;
  if (!conn) {
    return ouvirLocal((t) => {
      const todos = Object.entries(t.alertas).map(([id, a]) => normalizar(id, a)).filter((a) => a.celulas?.includes(celula));
      cb({ ativos: todos.filter((a) => a.status === 'ativo').sort((a, b) => b.desde - a.desde),
           recuperados: todos.filter((a) => a.status === 'resolvido' && a.encerradoEm > corte) });
    });
  }
  const { fs, db } = conn;
  let ativos = [], recuperados = [];
  const base = (status) => fs.query(fs.collection(db, 'bairro'), fs.where('celulas', 'array-contains', celula), fs.where('status', '==', status));
  const p1 = fs.onSnapshot(base('ativo'), (s) => { ativos = s.docs.map((d) => normalizar(d.id, d.data())).sort((a, b) => b.desde - a.desde); cb({ ativos, recuperados }); },
    (e) => console.error('bairro', e));
  const p2 = fs.onSnapshot(base('resolvido'), (s) => { recuperados = s.docs.map((d) => normalizar(d.id, d.data())).filter((a) => a.encerradoEm > corte); cb({ ativos, recuperados }); },
    (e) => console.error('bairro', e));
  return () => { p1(); p2(); };
}

export function ouvirAjudantes(pet, cb) {
  if (!conn) return ouvirLocal((t) => cb(Object.entries(t.ajudantes[pet] || {}).map(([uid, a]) => ({ uid, ...a, em: paraData(a.em) }))));
  const { fs, db } = conn;
  return fs.onSnapshot(fs.collection(db, 'bairro', pet, 'ajudantes'),
    (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data(), em: paraData(d.data().em) }))), (e) => console.error('ajudantes', e));
}
export const souEu = (uid) => (conn ? conn.auth.currentUser?.uid === uid : uid === EU_LOCAL);

export async function estouProcurando(pet, apelido, ligar) {
  const uid = meuUid();
  if (!conn) {
    const t = lerLocal(); t.ajudantes[pet] = t.ajudantes[pet] || {};
    if (ligar) t.ajudantes[pet][uid] = { apelido, em: new Date().toISOString() }; else delete t.ajudantes[pet][uid];
    gravarLocal(t); return;
  }
  const { fs, db } = conn;
  const ref = fs.doc(db, 'bairro', pet, 'ajudantes', uid);
  if (ligar) await fs.setDoc(ref, { apelido, em: fs.serverTimestamp() }); else await fs.deleteDoc(ref);
}

export async function enviarAvistamento(pet, { apelido, lat, lng, precisao = null, nota = '' }) {
  const d = { apelido, lat: +lat.toFixed(6), lng: +lng.toFixed(6), precisao: precisao == null ? null : Math.round(precisao), nota: String(nota).slice(0, 200) };
  if (!conn) {
    const t = lerLocal(); t.avistamentos[pet] = t.avistamentos[pet] || [];
    t.avistamentos[pet].unshift({ ...d, autor: meuUid(), id: 'av_' + Date.now().toString(36), em: new Date().toISOString() });
    gravarLocal(t); return;
  }
  const { fs, db } = conn;
  await fs.addDoc(fs.collection(db, 'bairro', pet, 'avistamentos'), { ...d, autor: meuUid(), em: fs.serverTimestamp() });
}

export async function denunciar(pet, motivo) {
  if (!conn) return;                       // simulação: nada a enviar
  const { fs, db } = conn;
  await fs.addDoc(fs.collection(db, 'denuncias'), { alvo: pet, motivo: String(motivo).slice(0, 300), autor: meuUid(), em: fs.serverTimestamp() });
}

// ---------------------------------------------------------------- lado do tutor
export function ouvirMeuAlerta(pet, cb) {
  if (!conn) return ouvirLocal((t) => cb(t.alertas[pet] ? normalizar(pet, t.alertas[pet]) : null));
  const { fs, db } = conn;
  return fs.onSnapshot(fs.doc(db, 'bairro', pet), (s) => cb(s.exists() ? normalizar(s.id, s.data()) : null),
    (e) => { console.error('meu alerta', e); cb(null); });
}
export function ouvirAvistamentos(pet, cb) {
  if (!conn) return ouvirLocal((t) => cb((t.avistamentos[pet] || []).map((a) => ({ ...a, em: paraData(a.em) }))));
  const { fs, db } = conn;
  const q = fs.query(fs.collection(db, 'bairro', pet, 'avistamentos'), fs.orderBy('em', 'desc'), fs.limit(30));
  return fs.onSnapshot(q, (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data(), em: paraData(d.data().em) }))), (e) => console.error('avistamentos', e));
}

// publica (ou republica) o alerta do pet na quadrícula do tutor
export async function publicarAlerta({ pet, nome, foto = '', descricao = '', vizinho }) {
  const d = {
    pet, nome: String(nome).slice(0, 40), foto: foto && foto.length < 400000 ? foto : '',
    descricao: String(descricao).slice(0, 200), bairro: vizinho.bairro, celula: vizinho.celula,
    celulas: celulasAoRedor(vizinho.celula), status: 'ativo'
  };
  if (!conn) {
    const t = lerLocal();
    const antes = t.alertas[pet];
    t.alertas[pet] = { ...d, desde: antes?.status === 'ativo' ? antes.desde : new Date().toISOString(), encerradoEm: null };
    if (!antes || antes.status !== 'ativo') { t.ajudantes[pet] = {}; t.avistamentos[pet] = []; }
    gravarLocal(t); return;
  }
  const { fs, db } = conn;
  const ref = fs.doc(db, 'bairro', pet);
  const atual = await fs.getDoc(ref);
  if (atual.exists() && atual.data().status === 'ativo') {
    await fs.updateDoc(ref, { ...d, atualizadoEm: fs.serverTimestamp() });
  } else {
    // nova busca: "desde" recomeça; ajudas e avistamentos de buscas antigas são filtrados pela data
    await fs.setDoc(ref, { ...d, desde: fs.serverTimestamp(), atualizadoEm: fs.serverTimestamp(), encerradoEm: null });
  }
}
export async function encerrarAlerta(pet) {
  if (!conn) {
    const t = lerLocal();
    if (t.alertas[pet]) { t.alertas[pet].status = 'resolvido'; t.alertas[pet].encerradoEm = new Date().toISOString(); gravarLocal(t); }
    return;
  }
  const { fs, db } = conn;
  const ref = fs.doc(db, 'bairro', pet);
  const atual = await fs.getDoc(ref);
  if (atual.exists() && atual.data().status === 'ativo') await fs.updateDoc(ref, { status: 'resolvido', encerradoEm: fs.serverTimestamp(), atualizadoEm: fs.serverTimestamp() });
}

// ---------------------------------------------------------------- simulação: vizinhos ajudando
export function simularVizinhos(pet, perto) {
  if (conn) return false;
  const t = lerLocal();
  if (!t.alertas[pet] || t.alertas[pet].status !== 'ativo') return false;
  t.ajudantes[pet] = { ...(t.ajudantes[pet] || {}), v1: { apelido: 'Carlos', em: new Date().toISOString() }, v2: { apelido: 'Dona Lúcia', em: new Date().toISOString() } };
  t.avistamentos[pet] = t.avistamentos[pet] || [];
  t.avistamentos[pet].unshift({
    id: 'av_' + Date.now().toString(36), autor: 'v1', apelido: 'Carlos', nota: 'Vi passando correndo perto da praça, sentido da avenida.',
    lat: +(perto.lat + 0.0009).toFixed(6), lng: +(perto.lng - 0.0006).toFixed(6), precisao: 15, em: new Date().toISOString()
  });
  gravarLocal(t);
  return true;
}
export function reiniciarSimulacaoBairro() { try { localStorage.removeItem(CHAVE); } catch { /* ok */ } window.dispatchEvent(new Event(EVENTO)); }
