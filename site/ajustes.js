// Configurações: aparência da plataforma, dados do tutor e ficha privada do pet.
//
// Onde fica cada coisa:
//   aparência   localStorage 'coleira-layout' (aplicada antes da página aparecer) e,
//               com Firebase, também em tutores/{uid}.layout para seguir o tutor em outro aparelho
//   tutor       tutores/{uid}: nome, telefone, mostrarTelefone (privado: só o próprio tutor lê)
//   ficha       pets/{pet}/config/ficha: nascimento, peso, sexo, castrado, microchip, veterinário
//               (privado: só o tutor e a coleira)
// Sem Firebase (simulação) tudo fica no localStorage deste navegador.
import { PET_ID } from './firebase-config.js';
import { configurado, abrirFirestore } from './perfil-dados.js';

export const LAYOUT_PADRAO = {
  tema: 'parque', mascote: 'auto', patas: 'sim', titulos: 'arredondados', topo: 'colorido', texto: 'normal', movimento: 'normal'
};
const VALIDOS = {
  tema: ['parque', 'lavanda', 'ceu', 'caramelo'], mascote: ['auto', 'cao', 'gato', 'inicial'], patas: ['sim', 'nao'],
  titulos: ['arredondados', 'sistema'], topo: ['colorido', 'suave'], texto: ['normal', 'grande'], movimento: ['normal', 'reduzido']
};
const CHAVE_LAYOUT = 'coleira-layout';
const CHAVE_TUTOR = 'coleira-tutor';
const CHAVE_FICHA = 'coleira-ficha-' + PET_ID;

const ler = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

// só aceita valores conhecidos (o layout vem do localStorage ou do banco)
function limpar(l) {
  const r = { ...LAYOUT_PADRAO };
  for (const k in VALIDOS) if (VALIDOS[k].includes(l?.[k])) r[k] = l[k];
  return r;
}

export const lerLayout = () => limpar(ler(CHAVE_LAYOUT, {}));

export function aplicarLayout(l) {
  const h = document.documentElement;
  for (const k in l) h.dataset[k] = l[k];
  // a letra arredondada (Fredoka) só é baixada se o tutor quiser
  if (l.titulos === 'arredondados' && !document.getElementById('fonteTitulos')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.id = 'fonteTitulos';
    link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&display=swap';
    document.head.append(link);
  }
  window.dispatchEvent(new CustomEvent('layout-mudou', { detail: l }));
}

async function usuario() {
  if (!configurado) return null;
  const c = await abrirFirestore();
  const u = c.auth.currentUser;
  return u && !u.isAnonymous ? { c, u } : null;
}

export async function salvarLayout(l) {
  const limpo = limpar(l);
  gravar(CHAVE_LAYOUT, limpo);
  const x = await usuario();
  if (x) await x.c.fs.setDoc(x.c.fs.doc(x.c.db, 'tutores', x.u.uid), { layout: limpo, atualizadoEm: x.c.fs.serverTimestamp() }, { merge: true });
  return limpo;
}

// ---------------------------------------------------------------- tutor
export async function lerTutor() {
  const x = await usuario();
  if (!x) return ler(CHAVE_TUTOR, {});
  const snap = await x.c.fs.getDoc(x.c.fs.doc(x.c.db, 'tutores', x.u.uid));
  const d = snap.exists() ? snap.data() : {};
  // a aparência salva na conta vale também neste aparelho
  if (d.layout) { const l = limpar(d.layout); gravar(CHAVE_LAYOUT, l); aplicarLayout(l); }
  return { ...d, email: x.u.email };
}
export async function salvarTutor({ nome, telefone, mostrarTelefone }) {
  const d = { nome: String(nome).slice(0, 60), telefone: String(telefone).slice(0, 20), mostrarTelefone: !!mostrarTelefone };
  const x = await usuario();
  if (!x) { if (!gravar(CHAVE_TUTOR, d)) throw new Error('o navegador não deixou salvar'); return d; }
  await x.c.fs.setDoc(x.c.fs.doc(x.c.db, 'tutores', x.u.uid), { ...d, atualizadoEm: x.c.fs.serverTimestamp() }, { merge: true });
  return d;
}
export async function enviarTrocaSenha() {
  const x = await usuario();
  if (!x) throw new Error('No modo simulação não há conta.');
  await x.c.au.sendPasswordResetEmail(x.c.auth, x.u.email);
  return x.u.email;
}

// ---------------------------------------------------------------- ficha privada do pet
const FICHA_CAMPOS = ['nascimento', 'peso', 'sexo', 'castrado', 'microchip', 'veterinario', 'vetTelefone'];
export async function lerFicha() {
  const x = await usuario();
  if (!x) return ler(CHAVE_FICHA, {});
  const snap = await x.c.fs.getDoc(x.c.fs.doc(x.c.db, 'pets', PET_ID, 'config', 'ficha'));
  return snap.exists() ? snap.data() : {};
}
export async function salvarFicha(dados) {
  const d = {};
  FICHA_CAMPOS.forEach((k) => { if (dados[k] !== undefined) d[k] = dados[k]; });
  const x = await usuario();
  if (!x) { if (!gravar(CHAVE_FICHA, d)) throw new Error('o navegador não deixou salvar'); return d; }
  await x.c.fs.setDoc(x.c.fs.doc(x.c.db, 'pets', PET_ID, 'config', 'ficha'), { ...d, atualizadoEm: x.c.fs.serverTimestamp() }, { merge: true });
  return d;
}

// idade a partir da data de nascimento (ex.: "3 anos", "7 meses")
export function idade(nascimento) {
  if (!nascimento) return '';
  const n = new Date(nascimento + 'T12:00:00');
  if (isNaN(n)) return '';
  const hoje = new Date();
  let meses = (hoje.getFullYear() - n.getFullYear()) * 12 + hoje.getMonth() - n.getMonth();
  if (hoje.getDate() < n.getDate()) meses--;
  if (meses < 0) return '';
  if (meses < 12) return meses <= 1 ? `${Math.max(meses, 0)} mês` : `${meses} meses`;
  const anos = Math.floor(meses / 12);
  return anos === 1 ? '1 ano' : `${anos} anos`;
}
