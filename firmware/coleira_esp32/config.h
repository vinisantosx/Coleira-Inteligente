#pragma once
// ===================== CONFIGURACAO DA COLEIRA =====================
// Preencha com os seus dados antes de gravar na ESP32.

// --- Wi-Fi (prototipo: rede da casa ou roteador do celular) ---
#define WIFI_SSID        "NOME_DA_REDE"
#define WIFI_SENHA       "SENHA_DA_REDE"

// --- Firebase (mesmo projeto usado no site: Configuracoes do projeto > Geral) ---
#define FIREBASE_PROJECT_ID  "seu-projeto-id"
#define FIREBASE_API_KEY     "SUA_API_KEY"

// --- Pet ---
#define PET_ID    "rex"          // id do documento em pets/{PET_ID}
#define PET_NOME  "Rex"

// --- Area segura padrao (o site pode alterar em config/area) ---
#define CASA_LAT_PADRAO   -12.249644
#define CASA_LNG_PADRAO   -38.963241
#define RAIO_PADRAO_M      50.0

// --- WhatsApp via CallMeBot (gratuito, para fins pessoais) ---
// 1) Adicione o numero do CallMeBot nos contatos (veja o numero atual em callmebot.com)
// 2) Envie para ele: "I allow callmebot to send me messages"
// 3) Ele responde com a sua apikey. Deixe WHATSAPP_ATIVO 0 para desligar.
#define WHATSAPP_ATIVO      1
#define WHATSAPP_TELEFONE   "+5571999999999"
#define CALLMEBOT_APIKEY    "123456"

// --- Pinos (ESP32 DevKit V1) ---
#define PINO_GPS_RX    16   // recebe do TX do GPS
#define PINO_GPS_TX    17   // envia para o RX do GPS
#define PINO_SDA       21   // MAX30102
#define PINO_SCL       22
#define PINO_LED       25
#define PINO_BATERIA   34   // divisor 100k/100k

// --- Ajustes ---
#define LIMIAR_PRESENCA_IR   30000  // IR acima disso = coleira encostada no pet (ajuste com o monitor serial)
#define INTERVALO_ENVIO_MS   10000  // envio normal
#define INTERVALO_ALERTA_MS   3000  // envio quando fora da area
#define INTERVALO_CONFIG_MS  60000  // busca a area segura no Firebase
#define BATERIA_BAIXA_PCT       15
