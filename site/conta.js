// Login com e-mail e senha (Firebase Auth). Usado pelo painel do tutor e pela
// página da rede do bairro. Sem Firebase configurado (simulação), não aparece.
import { abrirFirestore } from './perfil-dados.js';

const ERROS = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'Esse e-mail não parece válido.',
  'auth/email-already-in-use': 'Já existe uma conta com esse e-mail. Use "Entrar".',
  'auth/credential-already-in-use': 'Já existe uma conta com esse e-mail. Use "Entrar".',
  'auth/weak-password': 'A senha precisa ter pelo menos 8 caracteres.',
  'auth/too-many-requests': 'Muitas tentativas. Espere alguns minutos e tente de novo.',
  'auth/network-request-failed': 'Sem conexão com a internet.',
  'auth/operation-not-allowed': 'Login por e-mail não está ativado no Firebase (Authentication > Sign-in method).'
};
const msgErro = (err) => ERROS[err?.code] || ('Não foi possível entrar: ' + (err?.message || err));

// Mostra a tela de login até alguém entrar com e-mail e senha. Resolve com o usuário.
export async function exigirLogin({ titulo = 'Entrar', texto = '' } = {}) {
  const { au, auth } = await abrirFirestore();
  await auth.authStateReady();
  if (auth.currentUser && !auth.currentUser.isAnonymous) return auth.currentUser;

  return new Promise((resolver) => {
    const fundo = document.createElement('div');
    fundo.className = 'login-fundo';
    fundo.innerHTML = `
      <form class="login-cartao" novalidate>
        <p class="login-marca">Vitalar</p>
        <h1></h1>
        <p class="dica login-texto"></p>
        <label class="campo">E-mail <input name="email" type="email" autocomplete="email" required></label>
        <label class="campo">Senha <input name="senha" type="password" autocomplete="current-password" minlength="8" required></label>
        <p class="qr-status" role="status"></p>
        <button class="botao primario grande" type="submit" data-modo="entrar">Entrar</button>
        <div class="login-links">
          <button type="button" class="link" data-acao="alternar">Criar conta</button>
          <button type="button" class="link" data-acao="esqueci">Esqueci a senha</button>
        </div>
      </form>`;
    fundo.querySelector('h1').textContent = titulo;
    fundo.querySelector('.login-texto').textContent = texto;
    document.body.append(fundo);
    const form = fundo.querySelector('form');
    const st = fundo.querySelector('.qr-status');
    const botao = form.querySelector('[type="submit"]');
    let criando = false;
    form.email.focus();

    fundo.querySelector('[data-acao="alternar"]').addEventListener('click', (ev) => {
      criando = !criando;
      botao.textContent = criando ? 'Criar conta' : 'Entrar';
      ev.target.textContent = criando ? 'Já tenho conta' : 'Criar conta';
      form.senha.autocomplete = criando ? 'new-password' : 'current-password';
      st.textContent = criando ? 'Use uma senha com pelo menos 8 caracteres que você não usa em outros sites.' : '';
      st.className = 'qr-status';
    });
    fundo.querySelector('[data-acao="esqueci"]').addEventListener('click', async () => {
      if (!form.email.value) { st.textContent = 'Digite o seu e-mail acima e toque de novo em "Esqueci a senha".'; st.className = 'qr-status erro'; return; }
      try {
        await au.sendPasswordResetEmail(auth, form.email.value.trim());
        st.textContent = 'Se houver uma conta com esse e-mail, enviamos um link para criar uma nova senha.'; st.className = 'qr-status ok';
      } catch (err) { st.textContent = msgErro(err); st.className = 'qr-status erro'; }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = form.email.value.trim(), senha = form.senha.value;
      if (criando && senha.length < 8) { st.textContent = ERROS['auth/weak-password']; st.className = 'qr-status erro'; return; }
      botao.disabled = true; st.textContent = 'Aguarde...'; st.className = 'qr-status';
      try {
        // Quem já usou o site sem conta (ex.: avisou pelo QR) mantém a mesma identidade ao criar a conta:
        // assim os selos de boa ação que ganhou continuam com a pessoa.
        const r = criando
          ? (auth.currentUser?.isAnonymous
            ? await au.linkWithCredential(auth.currentUser, au.EmailAuthProvider.credential(email, senha))
            : await au.createUserWithEmailAndPassword(auth, email, senha))
          : await au.signInWithEmailAndPassword(auth, email, senha);
        fundo.remove();
        resolver(r.user);
      } catch (err) {
        st.textContent = msgErro(err); st.className = 'qr-status erro';
        botao.disabled = false;
      }
    });
  });
}

export async function sair() {
  const { au, auth } = await abrirFirestore();
  await au.signOut(auth);
  location.reload();
}

export async function emailAtual() {
  const { auth } = await abrirFirestore();
  return auth.currentUser?.email || '';
}
