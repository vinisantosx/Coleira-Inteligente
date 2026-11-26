// Dados compartilhados entre o painel (index.html), a página do QR (perdido.html)
// e a comunidade.
//
// Firestore (regras em firestore.rules):
//   acesso/{pet}                 dono (uid do tutor) e coleira (uid da coleira)
//   perfis/{pet}                 PÚBLICO: nome, foto, telefone, recado, perdido, perdidoDesde, encontrado
//   pets/{pet}                   estado da coleira (só dono e coleira)
//   pets/{pet}/config/area       área segura
//   pets/{pet}/saude/{dia}       resumo diário
//   pets/{pet}/alertas/{id}      alertas
//   pets/{pet}/encontros/{id}    avisos de quem achou o pet (dono + quem criou)
//
// Login: o tutor entra com e-mail e senha; quem escaneia o QR e a coleira usam
// login anônimo (sem dados pessoais), só para as regras saberem quem é quem.
//
// Sem Firebase (modo simulação) os dados ficam no localStorage do navegador,
// então painel e página do QR conversam entre abas do mesmo navegador.
import { firebaseConfig, PET_ID, PET_NOME } from './firebase-config.js';

const FIREBASE_VERSAO = '10.12.2';
export const configurado = !!firebaseConfig.apiKey && firebaseConfig.apiKey !== 'COLE_AQUI';

export const PERFIL_PADRAO = { nome: PET_NOME, foto: '', telefone: '', recado: '', perdido: false, perdidoDesde: null, encontrado: null };

// ?emulador na URL (só em localhost) liga o site aos emuladores do Firebase
function usarEmulador() {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return false;
  try {
    if (new URLSearchParams(location.search).has('emulador')) sessionStorage.setItem('emulador', '1');
    return sessionStorage.getItem('emulador') === '1';
  } catch { return false; }
}

let conexao = null;
export function abrirFirestore() {
  if (!conexao) {
    conexao = (async () => {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSAO}`;
      const [app, fs, au] = await Promise.all([
        import(`${base}/firebase-app.js`), import(`${base}/firebase-firestore.js`), import(`${base}/firebase-auth.js`)
      ]);
      const inst = app.initializeApp(firebaseConfig);
      const db = fs.getFirestore(inst), auth = au.getAuth(inst);
      if (usarEmulador()) {          // só para testes locais (npx firebase emulators:start)
        fs.connectFirestoreEmulator(db, '127.0.0.1', 8089);
        au.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      }
      return { fs, db, au, auth };
    })();
  }
  return conexao;
}

// primeiro estado do login (o Firebase restaura a sessão salva no navegador)
export async function usuarioAtual() {
  const { au, auth } = await abrirFirestore();
  await auth.authStateReady();
  return auth.currentUser;
}

// quem escaneia o QR: login anônimo, sem pedir nada (as regras usam o uid)
export async function entrarAnonimo() {
  const { au, auth } = await abrirFirestore();
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  return (await au.signInAnonymously(auth)).user;
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
