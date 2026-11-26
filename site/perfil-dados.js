// Dados compartilhados entre o painel (index.html) e a página do QR (perdido.html).
//
// Firestore:
//   perfis/{PET_ID}   nome, foto, telefone, recado, perdido, perdidoDesde   (escrito pelo painel)
//   alertas/*         tipo "avistamento" é criado pela página do QR
//
// Sem Firebase (modo simulação) os dados ficam no localStorage do navegador,
// então painel e página do QR conversam entre abas do mesmo navegador.
import { firebaseConfig, PET_ID, PET_NOME } from './firebase-config.js';

const FIREBASE_VERSAO = '10.12.2';
export const configurado = !!firebaseConfig.apiKey && firebaseConfig.apiKey !== 'COLE_AQUI';

export const PERFIL_PADRAO = { nome: PET_NOME, foto: '', telefone: '', recado: '', perdido: false, perdidoDesde: null };

let conexao = null;
export function abrirFirestore() {
  if (!conexao) {
    conexao = (async () => {
      const app = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSAO}/firebase-app.js`);
      const fs = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSAO}/firebase-firestore.js`);
      return { fs, db: fs.getFirestore(app.initializeApp(firebaseConfig)) };
    })();
  }
  return conexao;
}

// ---------- armazenamento local (simulação) ----------
const ler = (chave, padrao) => {
  try { return JSON.parse(localStorage.getItem(chave)) ?? padrao; } catch { return padrao; }
};
const gravar = (chave, valor) => {
  try { localStorage.setItem(chave, JSON.stringify(valor)); return true; } catch { return false; }
};

export const CHAVE_PERFIL = 'coleira-perfil-' + PET_ID;
export const CHAVE_AVISTAMENTOS = 'coleira-avistamentos-' + PET_ID;

export const perfilLocal = () => ({ ...PERFIL_PADRAO, ...ler(CHAVE_PERFIL, {}) });
export const salvarPerfilLocal = (p) => gravar(CHAVE_PERFIL, p);
export const avistamentosLocais = () => ler(CHAVE_AVISTAMENTOS, []);
export function adicionarAvistamentoLocal(a) {
  const lista = avistamentosLocais();
  lista.unshift(a);
  return gravar(CHAVE_AVISTAMENTOS, lista.slice(0, 30));
}

// ---------- utilidades ----------
export function telefoneWhatsApp(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;   // número brasileiro sem DDI
  return d;
}

export function telefoneBonito(tel) {
  const d = String(tel || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return tel || '';
}

export const urlPaginaQR = (pet = PET_ID) => new URL(`perdido.html?pet=${encodeURIComponent(pet)}`, location.href).href;

// reduz a foto para caber com folga num documento do Firestore (~20-40 KB)
export function reduzirFoto(arquivo, lado = 320) {
  return new Promise((ok, erro) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const cv = document.createElement('canvas');
      cv.width = cv.height = lado;
      cv.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, lado, lado);
      URL.revokeObjectURL(img.src);
      ok(cv.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => erro(new Error('Não consegui abrir essa imagem.'));
    img.src = URL.createObjectURL(arquivo);
  });
}
