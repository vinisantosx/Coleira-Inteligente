// =============================================================
// Configuracao do Firebase e do pet
// Cole aqui o firebaseConfig do seu projeto (Console do Firebase >
// Configuracoes do projeto > Seus apps > SDK). Enquanto apiKey estiver
// como "COLE_AQUI", o site roda em MODO SIMULACAO (sem coleira).
// =============================================================
export const firebaseConfig = {
  apiKey: "COLE_AQUI",
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000"
};

// Deve ser igual ao PET_ID do firmware (config.h)
export const PET_ID = "rex";
export const PET_NOME = "Rex";

// Area segura usada ate o tutor salvar outra pelo site
export const AREA_PADRAO = { lat: -12.249644, lng: -38.963241, raio: 50 };

// Se a coleira ficar este tempo sem enviar dados, o site avisa "sem sinal"
export const SEM_SINAL_SEGUNDOS = 60;
