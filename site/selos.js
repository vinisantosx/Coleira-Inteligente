// Selos de boa ação: reconhecimento que o TUTOR dá a quem ajudou a recuperar o pet dele.
//
// Como funciona (e por que é difícil de fraudar):
//   - ninguém se dá selo: só o dono do pet cria um reconhecimento, e as regras do Firestore
//     conferem que a pessoa reconhecida é mesmo a autora do encontro pelo QR, do avistamento
//     ou do "estou procurando" daquele pet;
//   - "devolveu" só vale para um encontro já encerrado (o pet voltou);
//   - um reconhecimento por ajuda (o id é pet + origem + id da ajuda) e ninguém reconhece a si mesmo;
//   - os selos maiores contam FAMÍLIAS diferentes (tutores distintos), então um tutor sozinho
//     não consegue "fabricar" um Guardião.
//   - o reconhecimento não guarda local, telefone nem mensagem: só quem, qual pet e o tipo.
//
// Firestore  reconhecimentos/{pet}__{origem}__{origemId}:
//   para (uid de quem ajudou), de (uid do tutor), pet, origem: 'encontro'|'avistamento'|'ajudante',
//   origemId, tipo: 'devolveu'|'ajudou', criadoEm
//
// Sem Firebase (simulação) fica no localStorage, com alguns vizinhos de exemplo já premiados.
import { configurado, abrirFirestore } from './perfil-dados.js';

export const SELOS = [
  { id: 'olhar', nome: 'Olhar Atento', icone: 'i-selo-olhar', criterio: 'Ajudou uma família a procurar o pet', comoGanhar: 'Ajude uma família a procurar o pet', meta: 1 },
  { id: 'anjo', nome: 'Anjo dos Pets', icone: 'i-selo-anjo', criterio: 'Encontrou e devolveu um pet', comoGanhar: 'Encontre e devolva um pet', meta: 1 },
  { id: 'guardiao', nome: 'Guardião dos Animais', icone: 'i-selo-guardiao', criterio: 'Ajudou 3 famílias diferentes', comoGanhar: 'Ajude 3 famílias diferentes', meta: 3 },
  { id: 'protetor', nome: 'Protetor do Bairro', icone: 'i-selo-protetor', criterio: 'Ajudou 10 famílias diferentes', comoGanhar: 'Ajude 10 famílias diferentes', meta: 10 }
];
const ORDEM = ['protetor', 'guardiao', 'anjo', 'olhar'];      // do maior para o menor
export const seloPorId = (id) => SELOS.find((s) => s.id === id);

const CHAVE = 'coleira-reconhecimentos';
const EVENTO = 'selos-mudou';
export const EU_SIMULACAO = 'eu';                // mesmo "eu" da rede do bairro em simulação
export const ACHADOR_SIMULACAO = 'achador-local'; // quem avisa pelo QR em simulação
let conn = null;

export async function iniciarSelos() {
  if (configurado && !conn) {
    try { conn = await abrirFirestore(); } catch (err) { console.error(err); conn = null; }
  }
  return !!conn;
}
export const meuUidSelos = () => (conn ? conn.auth.currentUser?.uid || null : EU_SIMULACAO);

// ---------------------------------------------------------------- cálculo
// lista de reconhecimentos de UMA pessoa -> selos conquistados, o principal e o próximo
export function calcularSelos(lista = []) {
  const familias = new Set(lista.map((r) => r.de)).size;
  const devolveu = lista.some((r) => r.tipo === 'devolveu');
  const tem = {
    olhar: familias >= 1,
    anjo: devolveu,
    guardiao: familias >= 3,
    protetor: familias >= 10
  };
  const conquistados = ORDEM.filter((id) => tem[id]);
  const principal = conquistados.length ? seloPorId(conquistados[0]) : null;
  const proximo = !tem.olhar ? { selo: seloPorId('olhar'), falta: 1 }
    : !tem.guardiao ? { selo: seloPorId('guardiao'), falta: 3 - familias }
    : !tem.protetor ? { selo: seloPorId('protetor'), falta: 10 - familias } : null;
  return { familias, ajudas: lista.length, devolveu, tem, conquistados, principal, proximo };
}

// ---------------------------------------------------------------- simulação
const h = (horas) => new Date(Date.now() - horas * 3600e3).toISOString();
function semente() {
  // vizinhos de exemplo da rede simulada: Carlos (v1) já é Guardião; Dona Lúcia (v2) é Anjo dos Pets
  const r = (para, de, pet, tipo, horas) => [`${pet}__ajudante__${para}`, { para, de, pet, origem: 'ajudante', origemId: para, tipo, criadoEm: h(horas) }];
  return Object.fromEntries([
    r('v1', 't1', 'luna', 'ajudou', 400), r('v1', 't2', 'bidu', 'devolveu', 300), r('v1', 't3', 'pipoca', 'ajudou', 100),
    r('v2', 't4', 'fred', 'devolveu', 50), r('v3', 't5', 'max', 'ajudou', 30)
  ]);
}
const lerLocal = () => { try { return JSON.parse(localStorage.getItem(CHAVE)) || semente(); } catch { return semente(); } };
function gravarLocal(d) {
  try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch { throw new Error('o navegador não deixou salvar'); }
  cache.clear();
  window.dispatchEvent(new Event(EVENTO));
}
export function aoMudarSelos(fn) {
  window.addEventListener(EVENTO, fn);
  window.addEventListener('storage', (e) => { if (e.key === CHAVE) { cache.clear(); fn(); } });
}

// ---------------------------------------------------------------- leitura
const cache = new Map();           // uid -> { quando, lista }
const VALIDADE_MS = 5 * 60e3;
const paraData = (v) => (!v ? null : v.toDate ? v.toDate() : new Date(v));

// reconhecimentos recebidos por várias pessoas de uma vez (para mostrar selo ao lado do apelido)
export async function reconhecimentosDe(uids) {
  const faltam = [...new Set(uids.filter(Boolean))].filter((u) => !(cache.get(u)?.quando > Date.now() - VALIDADE_MS));
  if (faltam.length) {
    const novos = Object.fromEntries(faltam.map((u) => [u, []]));
    if (!conn) {
      Object.values(lerLocal()).forEach((r) => { if (novos[r.para]) novos[r.para].push({ ...r, criadoEm: paraData(r.criadoEm) }); });
    } else {
      const { fs, db } = conn;
      for (let i = 0; i < faltam.length; i += 30) {               // "in" aceita até 30 valores
        const q = fs.query(fs.collection(db, 'reconhecimentos'), fs.where('para', 'in', faltam.slice(i, i + 30)), fs.limit(300));
        const s = await fs.getDocs(q);
        s.docs.forEach((d) => { const r = d.data(); novos[r.para]?.push({ id: d.id, ...r, criadoEm: paraData(r.criadoEm) }); });
      }
    }
    Object.entries(novos).forEach(([u, lista]) => cache.set(u, { quando: Date.now(), lista }));
  }
  return Object.fromEntries(uids.map((u) => [u, cache.get(u)?.lista || []]));
}
export async function selosDe(uids) {
  const r = await reconhecimentosDe(uids);
  return Object.fromEntries(Object.entries(r).map(([u, l]) => [u, calcularSelos(l)]));
}

// o que este tutor já reconheceu para um pet (para mostrar "✓ reconhecido" e permitir desfazer)
export async function reconhecimentosQueDei(pet) {
  if (!conn) return Object.entries(lerLocal()).filter(([, r]) => r.pet === pet && r.de === 'tutor-local').map(([id, r]) => ({ id, ...r }));
  const { fs, db } = conn;
  const uid = conn.auth.currentUser?.uid;
  if (!uid) return [];
  const q = fs.query(fs.collection(db, 'reconhecimentos'), fs.where('de', '==', uid), fs.where('pet', '==', pet), fs.limit(200));
  const s = await fs.getDocs(q);
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------- escrita (só o tutor)
export const idReconhecimento = (pet, origem, origemId) => `${pet}__${origem}__${origemId}`;

export async function reconhecer({ pet, origem, origemId, para, tipo }) {
  if (!['encontro', 'avistamento', 'ajudante'].includes(origem) || !['devolveu', 'ajudou'].includes(tipo)) throw new Error('reconhecimento inválido');
  if (!para) throw new Error('Não dá para saber quem enviou esta ajuda.');
  const id = idReconhecimento(pet, origem, origemId);
  if (!conn) {
    const t = lerLocal();
    if (!t[id]) { t[id] = { para, de: 'tutor-local', pet, origem, origemId, tipo, criadoEm: new Date().toISOString() }; gravarLocal(t); }
    return id;
  }
  const { fs, db } = conn;
  const ref = fs.doc(db, 'reconhecimentos', id);
  if ((await fs.getDoc(ref)).exists()) return id;              // já reconhecido: nada a fazer
  await fs.setDoc(ref, { para, de: conn.auth.currentUser.uid, pet, origem, origemId, tipo, criadoEm: fs.serverTimestamp() });
  cache.delete(para);
  window.dispatchEvent(new Event(EVENTO));
  return id;
}

export async function retirarReconhecimento(id, para) {
  if (!conn) { const t = lerLocal(); delete t[id]; gravarLocal(t); return; }
  const { fs, db } = conn;
  await fs.deleteDoc(fs.doc(db, 'reconhecimentos', id));
  cache.delete(para);
  window.dispatchEvent(new Event(EVENTO));
}

// área de testes: dá ao "eu" da simulação alguns reconhecimentos de famílias fictícias
export function simularSelosRecebidos(qtd = 3, devolveu = true) {
  if (conn) return false;
  const t = lerLocal();
  for (let i = 0; i < qtd; i++) {
    const pet = 'pet' + (i + 1);
    t[`${pet}__ajudante__${EU_SIMULACAO}`] = {
      para: EU_SIMULACAO, de: 'familia' + (i + 1), pet, origem: 'ajudante', origemId: EU_SIMULACAO,
      tipo: devolveu && i === 0 ? 'devolveu' : 'ajudou', criadoEm: h(24 * (i + 1))
    };
  }
  gravarLocal(t);
  return true;
}
export function zerarSelosSimulacao() { try { localStorage.removeItem(CHAVE); } catch { /* ok */ } cache.clear(); window.dispatchEvent(new Event(EVENTO)); }

// ---------------------------------------------------------------- aparência
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// chip pequeno para ir ao lado do apelido (string HTML, já escapada)
export function seloChip(info, { curto = false } = {}) {
  if (!info?.principal) return '';
  const s = info.principal;
  const dica = `${s.nome}: ajudou ${info.familias} ${info.familias === 1 ? 'família' : 'famílias'}${info.devolveu ? ', já devolveu um pet' : ''}`;
  return `<span class="selo-chip selo-${s.id}" title="${esc(dica)}"><svg aria-hidden="true"><use href="#${s.icone}"/></svg>${curto ? '' : esc(s.nome)}${curto ? `<span class="sr-only">${esc(s.nome)}</span>` : ''}</span>`;
}
// medalha grande (configurações, página do QR)
export function seloMedalha(s, ganho, detalhe = '') {
  return `<li class="selo-medalha selo-${s.id} ${ganho ? 'ganho' : 'falta'}">
    <span class="selo-disco"><svg aria-hidden="true"><use href="#${s.icone}"/></svg></span>
    <span class="selo-texto"><b>${esc(s.nome)}</b><small>${esc(detalhe || s.criterio)}</small></span>
  </li>`;
}
