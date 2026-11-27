/*
  Vitalar - coleira inteligente para pet - firmware ESP32
  ------------------------------------------------
  Nucleo 1 (loop):  GPS NEO-6M, MAX30102 (batimentos + presenca), LED de alerta, bateria
  Nucleo 0 (tarefa): Wi-Fi, envio ao Firestore (REST), leitura da area segura, alertas WhatsApp

  Bibliotecas (Gerenciador de Bibliotecas da Arduino IDE):
    - UniversalTelegramBot        (Brian Lough)  -> bot do Telegram (telegram.h)
    - TinyGPSPlus                 (Mikal Hart)
    - SparkFun MAX3010x Pulse and Proximity Sensor Library
    - ArduinoJson  v7             (Benoit Blanchon)
  Placa: "ESP32 Dev Module" (pacote esp32 da Espressif 2.x ou 3.x)

  Estrutura no Firestore:
    pets/{PET_ID}        <- estado atual (escrito pela coleira)
    config/area          <- casa, raio e, se desenhada, o poligono (escrito pelo site)
    perfis/{PET_ID}      <- campo "perdido" (modo pet perdido, ligado pelo site)
    saude/{PET_ID}_{data} <- resumo do dia: distancia, minutos ativos, batimento em repouso

  Saude comparada com o proprio pet:
    - "repouso" = coleira no pet e quase parado por alguns minutos (pelo GPS)
    - a cada dia com pelo menos 30 min de repouso medido, a coleira atualiza o
      "normal" do pet (media movel de ~7 dias, guardada na memoria flash)
    - depois de 3 dias aprendendo, avisa quando o batimento em repouso foge do normal dele
    alertas/{auto}       <- historico de eventos (escrito pela coleira)
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <TinyGPSPlus.h>
#include <ArduinoJson.h>
#include "MAX30105.h"
#include "heartRate.h"
#include "time.h"
#include <Preferences.h>
#include "config.h"
#include "certificados.h"

// ------------------------------------------------ estado compartilhado
struct Estado {
  double lat = 0, lng = 0;
  bool   gpsFix = false;
  int    satelites = 0;
  int    bpm = 0;
  bool   coleiraNoPet = false;
  bool   dentroArea = true;
  double distancia = 0;
  int    bateriaPct = 100;
  bool   perdido = false;      // modo pet perdido ligado pelo tutor no site
  int    bpmRepouso = 0;       // media dos ultimos minutos em repouso
  bool   emRepouso = false;
  int8_t saudeAlerta = 0;      // 1 = acima do normal, -1 = abaixo, 0 = normal
  float  precisaoM = 0;        // precisao aproximada do GPS (HDOP x 5 m)
  float  velocidadeKmh = 0;
  unsigned long fixEm = 0;     // millis() da ultima posicao valida
};
struct Dia {                   // acumulado do dia (vai para saude/{PET_ID}_{data})
  char   data[11] = "";        // "AAAA-MM-DD" na hora local; vazio ate o NTP sincronizar
  double distanciaM = 0;
  int    minutosAtivos = 0;
  double bpmRepousoSoma = 0;
  int    bpmRepousoN = 0, bpmRepousoMin = 0, bpmRepousoMax = 0;
};
struct Base { float media = 0, var = 0; int dias = 0; };   // o "normal" do pet
#define AREA_MAX_PONTOS 16   // o mesmo limite das regras do Firestore e do site
// Area segura: circulo (casa + raio) ou poligono desenhado no site (3 a 16 cantos).
// "escala" ~ meia largura da area, usada para nao deixar a margem maior que a propria area.
struct Area {
  double lat = CASA_LAT_PADRAO, lng = CASA_LNG_PADRAO, raio = RAIO_PADRAO_M;
  uint8_t n = 0;                               // 0 = circulo
  double plat[AREA_MAX_PONTOS], plng[AREA_MAX_PONTOS];
  double escala = RAIO_PADRAO_M;
};

enum TipoEvento : uint8_t { SAIU_AREA, VOLTOU_AREA, COLEIRA_REMOVIDA, COLEIRA_COLOCADA, BATERIA_BAIXA,
                           BATIMENTO_ALTO, BATIMENTO_BAIXO };
struct Evento { TipoEvento tipo; double lat, lng; };

Estado estado;
Area area;
Dia dia;
Base base;
Preferences prefs;
SemaphoreHandle_t trava;
QueueHandle_t filaEventos;

TinyGPSPlus gps;
HardwareSerial SerialGPS(2);
MAX30105 sensor;
bool sensorOk = false;
volatile long ultimoIR = 0;
volatile int8_t perdidoMudouPeloSite = -1;   // 1 ligou, 0 desligou, -1 nada (avisa o Telegram)

// ------------------------------------------------ batimentos
const byte N_MEDIA = 6;
byte leituras[N_MEDIA];
byte posLeitura = 0, qtdLeituras = 0;
unsigned long ultimoBatimento = 0;
int bpmMedio = 0;
double somaBpmMin = 0;   // media do batimento dentro de cada minuto
int nBpmMin = 0;

// ------------------------------------------------ util
double distanciaMetros(double lat1, double lng1, double lat2, double lng2) {
  const double R = 6371000.0, r = PI / 180.0;
  double dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  double a = sin(dLat / 2) * sin(dLat / 2) + cos(lat1 * r) * cos(lat2 * r) * sin(dLng / 2) * sin(dLng / 2);
  return 2 * R * atan2(sqrt(a), sqrt(1 - a));
}

String urlEncode(const String &s) {
  String o; char hex[4];
  for (size_t i = 0; i < s.length(); i++) {
    unsigned char c = s[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += (char)c;
    else { snprintf(hex, sizeof(hex), "%%%02X", c); o += hex; }
  }
  return o;
}

String agoraISO() {
  time_t t = time(nullptr);
  if (t < 1700000000) return "";                // NTP ainda nao sincronizou
  struct tm tmUTC; gmtime_r(&t, &tmUTC);
  char buf[25]; strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tmUTC);
  return String(buf);
}

void enviarEvento(TipoEvento tipo, double lat, double lng) {
  Evento e{tipo, lat, lng};
  xQueueSend(filaEventos, &e, 0);
}

// ================================================= NUCLEO 1
void lerBateria() {
  static unsigned long ult = 0;
  if (millis() - ult < 5000) return;
  ult = millis();
  uint32_t mv = analogReadMilliVolts(PINO_BATERIA) * 2;   // divisor 1:2
  int pct = constrain(map((long)mv, 3300, 4150, 0, 100), 0, 100);
  static bool avisou = false;
  xSemaphoreTake(trava, portMAX_DELAY);
  estado.bateriaPct = pct;
  double la = estado.lat, ln = estado.lng;
  xSemaphoreGive(trava);
  if (pct <= BATERIA_BAIXA_PCT && !avisou) { avisou = true; enviarEvento(BATERIA_BAIXA, la, ln); }
  if (pct > BATERIA_BAIXA_PCT + 10) avisou = false;
}

void lerSensorCardiaco() {
  if (!sensorOk) return;
  long ir = sensor.getIR();
  ultimoIR = ir;

  // presenca: IR alto = sensor encostado no pet. Debounce para evitar alarme falso.
  static bool noPet = false;
  static unsigned long desde = 0;
  bool agora = ir > LIMIAR_PRESENCA_IR;
  if (agora != noPet) {
    if (desde == 0) desde = millis();
    unsigned long espera = agora ? 3000 : 8000;    // remover exige 8 s seguidos
    if (millis() - desde > espera) {
      noPet = agora; desde = 0;
      xSemaphoreTake(trava, portMAX_DELAY);
      estado.coleiraNoPet = noPet;
      double la = estado.lat, ln = estado.lng;
      xSemaphoreGive(trava);
      enviarEvento(noPet ? COLEIRA_COLOCADA : COLEIRA_REMOVIDA, la, ln);
    }
  } else desde = 0;

  if (agora && checkForBeat(ir)) {
    unsigned long d = millis() - ultimoBatimento;
    ultimoBatimento = millis();
    float bpm = 60.0 / (d / 1000.0);
    if (bpm > 30 && bpm < 250) {                    // faixa plausivel para caes e gatos
      leituras[posLeitura++] = (byte)bpm; posLeitura %= N_MEDIA;
      if (qtdLeituras < N_MEDIA) qtdLeituras++;
      int soma = 0; for (byte i = 0; i < qtdLeituras; i++) soma += leituras[i];
      bpmMedio = soma / qtdLeituras;
    }
  }
  if (!agora || millis() - ultimoBatimento > 6000) { bpmMedio = 0; qtdLeituras = 0; }

  static unsigned long ultPub = 0;
  if (millis() - ultPub > 500) {
    ultPub = millis();
    xSemaphoreTake(trava, portMAX_DELAY);
    estado.bpm = bpmMedio;
    if (bpmMedio > 0) { somaBpmMin += bpmMedio; nBpmMin++; }
    xSemaphoreGive(trava);
  }
}

// ------------------------------------------------ saude: roda uma vez por minuto
void avaliarMinuto() {
  static unsigned long ult = 0;
  if (millis() - ult < 60000) return;
  ult = millis();
  static double latAnt = 0, lngAnt = 0;
  static bool temAnt = false;
  static int minutosParado = 0;
  static float janela[10];
  static byte nJan = 0, posJan = 0;

  xSemaphoreTake(trava, portMAX_DELAY);
  bool fix = estado.gpsFix, noPet = estado.coleiraNoPet;
  double la = estado.lat, ln = estado.lng;
  Base b = base;
  int bpmMin = nBpmMin >= 20 ? (int)lround(somaBpmMin / nBpmMin) : 0;   // >= 10 s de leitura no minuto
  somaBpmMin = 0; nBpmMin = 0;
  xSemaphoreGive(trava);

  // quanto o pet andou neste minuto (sem GPS, ex.: dentro de casa, conta como parado)
  double movido = 0;
  if (fix) {
    if (temAnt) movido = distanciaMetros(latAnt, lngAnt, la, ln);
    latAnt = la; lngAnt = ln; temAnt = true;
  } else temAnt = false;
  if (movido > 2000) movido = 0;                        // salto do GPS, nao foi o pet
  bool ativo = movido > MOVIMENTO_ATIVO_M;
  if (movido > MOVIMENTO_RUIDO_M) minutosParado = 0; else minutosParado++;
  bool repouso = noPet && minutosParado >= MINUTOS_PARA_REPOUSO;

  if (repouso && bpmMin > 0) {
    janela[posJan] = bpmMin; posJan = (posJan + 1) % 10;
    if (nJan < 10) nJan++;
  } else if (!repouso) { nJan = 0; posJan = 0; }        // compara so repouso continuo
  float mediaJan = 0;
  for (byte i = 0; i < nJan; i++) mediaJan += janela[i];
  if (nJan) mediaJan /= nJan;

  int8_t alerta = 0;
  bool podeAvaliar = b.dias >= DIAS_PARA_APRENDER && nJan >= 8;
  if (podeAvaliar) {
    float limite = max(max(0.20f * b.media, 3.0f * sqrtf(b.var)), 12.0f);
    if (mediaJan > b.media + limite) alerta = 1;
    else if (mediaJan < b.media - limite) alerta = -1;
  }

  xSemaphoreTake(trava, portMAX_DELAY);
  if (movido > MOVIMENTO_RUIDO_M) dia.distanciaM += movido;
  if (ativo) dia.minutosAtivos++;
  if (repouso && bpmMin > 0) {
    dia.bpmRepousoSoma += bpmMin; dia.bpmRepousoN++;
    if (!dia.bpmRepousoMin || bpmMin < dia.bpmRepousoMin) dia.bpmRepousoMin = bpmMin;
    if (bpmMin > dia.bpmRepousoMax) dia.bpmRepousoMax = bpmMin;
  }
  estado.emRepouso = repouso;
  estado.bpmRepouso = nJan ? (int)lround(mediaJan) : 0;
  int8_t antes = estado.saudeAlerta;
  if (podeAvaliar) estado.saudeAlerta = alerta;         // so muda com 8+ minutos de repouso medido
  xSemaphoreGive(trava);

  if (podeAvaliar && alerta != 0 && antes != alerta) enviarEvento(alerta > 0 ? BATIMENTO_ALTO : BATIMENTO_BAIXO, la, ln);
}

// --- Area segura: protecao contra a imprecisao do GPS ---
// Valores padrao; para mudar, defina no config.h (nao precisa mexer aqui).
#ifndef MARGEM_AREA_M
#define MARGEM_AREA_M        10.0   // so "saiu" alem de raio + 10 m; so "voltou" aquem de raio - 10 m
#endif
#ifndef CONFIRMA_LEITURAS
#define CONFIRMA_LEITURAS       5   // leituras boas seguidas (1 por segundo) para confirmar a troca
#endif
#ifndef GPS_SATS_MIN
#define GPS_SATS_MIN            5   // menos satelites que isso: leitura nao decide nada
#endif
#ifndef GPS_HDOP_MAX
#define GPS_HDOP_MAX          2.5   // HDOP acima disso (~12 m de erro): leitura nao decide nada
#endif

// Distancia ate o limite da area, com sinal: positiva = fora, negativa = dentro.
// Hoje a area e um circulo; uma area desenhada (poligono) so precisa trocar esta funcao.
// Projecao local em metros (plana): erro desprezivel para areas de algumas centenas de metros.
static void paraMetros(double lat0, double lng0, double lat, double lng, double &x, double &y) {
  const double R = 6371000.0, r = PI / 180.0;
  x = (lng - lng0) * r * R * cos(lat0 * r);
  y = (lat - lat0) * r * R;
}

// Distancia do ponto (px, py) ao segmento (ax, ay)-(bx, by), tudo em metros.
static double distSegmento(double px, double py, double ax, double ay, double bx, double by) {
  double dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  double t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  double cx = ax + t * dx - px, cy = ay + t * dy - py;
  return sqrt(cx * cx + cy * cy);
}

double distanciaAoLimite(const Area &a, double lat, double lng, double *distCentro) {
  double d = distanciaMetros(a.lat, a.lng, lat, lng);
  if (distCentro) *distCentro = d;
  if (a.n < 3) return d - a.raio;                       // circulo

  // Poligono: "ponto dentro" pelo teste do raio (conta quantos lados a linha cruza)
  // e distancia ate o lado mais proximo. Negativa = dentro, positiva = fora.
  double px, py; paraMetros(a.lat, a.lng, lat, lng, px, py);
  bool dentro = false; double menor = 1e12;
  for (uint8_t i = 0, j = a.n - 1; i < a.n; j = i++) {
    double xi, yi, xj, yj;
    paraMetros(a.lat, a.lng, a.plat[i], a.plng[i], xi, yi);
    paraMetros(a.lat, a.lng, a.plat[j], a.plng[j], xj, yj);
    if (((yi > py) != (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) dentro = !dentro;
    double ds = distSegmento(px, py, xi, yi, xj, yj);
    if (ds < menor) menor = ds;
  }
  return dentro ? -menor : menor;
}

// Meia largura do poligono (area / perimetro x 2): num quadrado de 40 m da 20 m.
double escalaPoligono(const Area &a) {
  double area2 = 0, perim = 0;
  for (uint8_t i = 0, j = a.n - 1; i < a.n; j = i++) {
    double xi, yi, xj, yj;
    paraMetros(a.lat, a.lng, a.plat[i], a.plng[i], xi, yi);
    paraMetros(a.lat, a.lng, a.plat[j], a.plng[j], xj, yj);
    area2 += xj * yi - xi * yj;                 // 2 x area (formula do laco)
    perim += sqrt((xi - xj) * (xi - xj) + (yi - yj) * (yi - yj));
  }
  return perim > 0 ? fabs(area2) / perim : 0;
}

// Uma leitura so decide se o GPS esta confiavel: posicao recente, satelites e HDOP bons.
bool leituraConfiavel() {
  if (!gps.location.isValid() || gps.location.age() >= 5000) return false;
  if (!gps.satellites.isValid() || (int)gps.satellites.value() < GPS_SATS_MIN) return false;
  if (!gps.hdop.isValid() || gps.hdop.hdop() > GPS_HDOP_MAX) return false;
  return true;
}

void lerGPS() {
  while (SerialGPS.available()) gps.encode(SerialGPS.read());
  static unsigned long ult = 0;
  static int seguidas = 0;              // leituras boas seguidas apontando para o outro estado
  static double latTroca = 0, lngTroca = 0;   // primeiro ponto da sequencia (onde cruzou o limite)
  if (millis() - ult < 1000) return;
  ult = millis();

  bool fix = gps.location.isValid() && gps.location.age() < 5000;
  xSemaphoreTake(trava, portMAX_DELAY);
  Area a = area;
  estado.gpsFix = fix;
  estado.satelites = gps.satellites.isValid() ? gps.satellites.value() : 0;
  if (!fix) { xSemaphoreGive(trava); return; }

  // A posicao sempre atualiza o mapa, mesmo com GPS fraco.
  estado.lat = gps.location.lat();
  estado.lng = gps.location.lng();
  estado.fixEm = millis();
  estado.precisaoM = gps.hdop.isValid() ? gps.hdop.hdop() * 5.0f : 0;
  estado.velocidadeKmh = gps.speed.isValid() ? gps.speed.kmph() : 0;
  double limite = distanciaAoLimite(a, estado.lat, estado.lng, &estado.distancia);

  // 3) Leitura ruim nao decide nada: nao conta e nem zera a sequencia.
  if (!leituraConfiavel()) { xSemaphoreGive(trava); return; }

  // 1) Margem: a faixa entre (limite - margem) e (limite + margem) nao muda o estado.
  //    Em areas pequenas a margem encolhe (no maximo 1/3 do raio) para "voltou" continuar possivel.
  double margem = min((double)MARGEM_AREA_M, a.escala / 3.0);
  bool apontaFora   = estado.dentroArea  && limite >  margem;
  bool apontaDentro = !estado.dentroArea && limite < -margem;

  if (!apontaFora && !apontaDentro) { seguidas = 0; xSemaphoreGive(trava); return; }

  // 2) Confirmacao: precisa de CONFIRMA_LEITURAS leituras boas seguidas do mesmo lado.
  if (seguidas == 0) { latTroca = estado.lat; lngTroca = estado.lng; }
  if (++seguidas < CONFIRMA_LEITURAS) { xSemaphoreGive(trava); return; }

  seguidas = 0;
  estado.dentroArea = apontaDentro;
  double la = latTroca, ln = lngTroca;
  xSemaphoreGive(trava);
  Serial.printf("[area] %s (%.0f m do limite, margem %.0f m)\n", apontaDentro ? "voltou" : "saiu", limite, margem);
  enviarEvento(apontaDentro ? VOLTOU_AREA : SAIU_AREA, la, ln);
}

void atualizarLED() {
  xSemaphoreTake(trava, portMAX_DELAY);
  bool fora = !estado.dentroArea, fix = estado.gpsFix, perdido = estado.perdido;
  xSemaphoreGive(trava);
  unsigned long t = millis();
  bool ligado;
  unsigned long c = t % 700;
  if (perdido)   ligado = c < 70 || (c > 140 && c < 210); // pisca-pisca duplo sem parar: modo perdido
  else if (fora) ligado = (t / 150) % 2;               // pisca rapido: "estou fora de casa"
  else if (!fix) ligado = (t % 2000) < 40;             // procurando satelites
  else           ligado = (t % 5000) < 40;             // ok, em casa
  digitalWrite(PINO_LED, ligado);
}

// ================================================= NUCLEO 0 (rede)
bool conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) vTaskDelay(pdMS_TO_TICKS(250));
  if (WiFi.status() == WL_CONNECTED) {
    configTime(FUSO_HORARIO_S, 0, "pool.ntp.org", "time.google.com");   // localtime = hora do Brasil
    Serial.printf("[wifi] conectado, IP %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  Serial.println("[wifi] falhou, tento de novo depois");
  return false;
}

String urlFirestore(const String &caminho) {
  return "https://firestore.googleapis.com/v1/projects/" FIREBASE_PROJECT_ID
         "/databases/(default)/documents/" + caminho + "?key=" FIREBASE_API_KEY;
}

// ================================================= login da coleira (Firebase Auth anonimo)
// A coleira cria uma conta anonima so dela na primeira vez e guarda o refresh token
// na memoria (NVS). O UID aparece no Monitor Serial: cole no site, em
// "Area de testes > Vincular a coleira". As regras do Firestore so deixam ESTE UID
// gravar os dados do pet. Nada de senha do tutor dentro da coleira.
String idToken, uidColeira;
unsigned long tokenExpira = 0;
bool avisouPermissao = false;
Preferences prefsAuth;

bool horaCerta() {                 // conferir certificado exige a data certa (NTP)
  for (int i = 0; i < 40 && time(nullptr) < 1700000000; i++) vTaskDelay(pdMS_TO_TICKS(250));
  return time(nullptr) >= 1700000000;
}

int postAuth(const String &url, const char *tipo, const String &corpo, String &resp) {
  WiFiClientSecure cli;
  cli.setCACert(GOOGLE_RAIZES);    // so aceita o Google de verdade
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(cli, url)) return -1;
  http.addHeader("Content-Type", tipo);
  int cod = http.POST(corpo);
  if (cod > 0) resp = http.getString();
  http.end();
  return cod;
}

bool garantirToken() {
  if (idToken.length() && (long)(tokenExpira - millis()) > 300000L) return true;   // vale por mais 5 min
  if (!horaCerta()) { Serial.println("[auth] aguardando a hora (NTP)"); return false; }
  prefsAuth.begin("auth", false);
  String refresh = prefsAuth.getString("refresh", "");
  String resp;
  JsonDocument d;
  bool nova = false;
  if (refresh.length()) {
    int cod = postAuth("https://securetoken.googleapis.com/v1/token?key=" FIREBASE_API_KEY,
                       "application/x-www-form-urlencoded", "grant_type=refresh_token&refresh_token=" + refresh, resp);
    if (cod == 200 && !deserializeJson(d, resp)) {
      idToken = d["id_token"].as<String>();
      uidColeira = d["user_id"].as<String>();
      prefsAuth.putString("refresh", d["refresh_token"].as<String>());
      tokenExpira = millis() + d["expires_in"].as<String>().toInt() * 1000UL;
    } else if (cod == 400) {       // conta apagada ou token revogado: cria outra
      prefsAuth.remove("refresh");
      refresh = "";
    } else {
      Serial.printf("[auth] erro %d ao renovar o token\n", cod);
    }
  }
  if (!refresh.length()) {
    int cod = postAuth("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" FIREBASE_API_KEY,
                       "application/json", "{\"returnSecureToken\":true}", resp);
    if (cod == 200 && !deserializeJson(d, resp)) {
      idToken = d["idToken"].as<String>();
      uidColeira = d["localId"].as<String>();
      prefsAuth.putString("refresh", d["refreshToken"].as<String>());
      tokenExpira = millis() + d["expiresIn"].as<String>().toInt() * 1000UL;
      nova = true;
    } else {
      Serial.printf("[auth] erro %d ao criar a conta da coleira. Ative o login Anonimo no Firebase.\n", cod);
    }
  }
  prefsAuth.end();
  if (idToken.length()) {
    static String mostrado;
    if (nova || mostrado != uidColeira) {
      Serial.println("==============================================================");
      Serial.printf("[auth] UID DA COLEIRA: %s\n", uidColeira.c_str());
      Serial.println("[auth] Cole no site: Area de testes > Vincular a coleira");
      Serial.println("==============================================================");
      mostrado = uidColeira;
    }
  }
  return idToken.length() > 0;
}

int requisicao(const char *metodo, const String &url, const String &corpo, String *resposta = nullptr) {
  WiFiClientSecure cli;
  cli.setCACert(GOOGLE_RAIZES);    // confere o certificado do Google (nada de setInsecure)
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(cli, url)) return -1;
  http.addHeader("Content-Type", "application/json");
  if (idToken.length()) http.addHeader("Authorization", "Bearer " + idToken);
  int cod = corpo.length() ? http.sendRequest(metodo, corpo) : http.sendRequest(metodo);
  if (resposta && cod > 0) *resposta = http.getString();
  http.end();
  if (cod == 403 && !avisouPermissao) {
    avisouPermissao = true;
    Serial.printf("[auth] Firestore recusou (403). A coleira ja foi vinculada no site? UID: %s\n", uidColeira.c_str());
  }
  if (cod == 401) tokenExpira = 0;   // token vencido: renova na proxima volta
  return cod;
}

double lerNumero(JsonVariantConst f) {
  if (f["doubleValue"].is<double>()) return f["doubleValue"].as<double>();
  if (f["integerValue"].is<const char *>()) return atof(f["integerValue"].as<const char *>());
  return NAN;
}

// Le o documento config/area no formato REST do Firestore. Falso = documento invalido (mantem a area atual).
bool lerAreaFirestore(const String &resp, Area &nova) {
  JsonDocument doc;
  if (deserializeJson(doc, resp)) return false;
  JsonObjectConst f = doc["fields"];
  double la = lerNumero(f["lat"]), ln = lerNumero(f["lng"]), r = lerNumero(f["raio"]);
  if (isnan(la) || isnan(ln) || isnan(r) || r < 5) return false;

  nova = Area(); nova.lat = la; nova.lng = ln; nova.raio = r; nova.escala = r;
  // Poligono desenhado no site: pontos = [{lat, lng}, ...]. Qualquer ponto invalido -> usa o circulo.
  const char *forma = f["forma"]["stringValue"] | "circulo";
  JsonArrayConst pts = f["pontos"]["arrayValue"]["values"];
  if (!strcmp(forma, "poligono") && pts.size() >= 3 && pts.size() <= AREA_MAX_PONTOS) {
    uint8_t n = 0; bool ok = true;
    for (JsonVariantConst p : pts) {
      double pla = lerNumero(p["mapValue"]["fields"]["lat"]), pln = lerNumero(p["mapValue"]["fields"]["lng"]);
      if (isnan(pla) || isnan(pln) || distanciaMetros(la, ln, pla, pln) > 5000) { ok = false; break; }
      nova.plat[n] = pla; nova.plng[n] = pln; n++;
    }
    if (ok) { nova.n = n; nova.escala = escalaPoligono(nova); }
    else Serial.println("[area] poligono invalido; usando o circulo");
  }
  return true;
}

void buscarArea() {
  String resp;
  int cod = requisicao("GET", urlFirestore("pets/" PET_ID "/config/area"), "", &resp);
  if (cod != 200) { Serial.printf("[area] GET %d (usando a area atual)\n", cod); return; }
  Area nova;
  if (!lerAreaFirestore(resp, nova)) return;
  xSemaphoreTake(trava, portMAX_DELAY);
  area = nova;
  xSemaphoreGive(trava);
  if (nova.n) Serial.printf("[area] poligono com %d cantos, casa %.6f, %.6f (meia largura %.0f m)\n", nova.n, nova.lat, nova.lng, nova.escala);
  else Serial.printf("[area] circulo: casa %.6f, %.6f raio %.0f m\n", nova.lat, nova.lng, nova.raio);
}

// modo pet perdido: o tutor liga/desliga no site (perfis/{PET_ID}.perdido)
void buscarModoPerdido() {
  String resp;
  // mask.fieldPaths: o Firestore devolve so o campo "perdido" (sem a foto do pet)
  int cod = requisicao("GET", urlFirestore("perfis/" PET_ID) + "&mask.fieldPaths=perdido", "", &resp);
  if (cod == 404) return;                                   // perfil ainda nao criado
  if (cod != 200) { Serial.printf("[perdido] GET %d\n", cod); return; }
  JsonDocument doc;
  if (deserializeJson(doc, resp)) return;
  bool perdido = doc["fields"]["perdido"]["booleanValue"] | false;
  xSemaphoreTake(trava, portMAX_DELAY);
  bool mudou = perdido != estado.perdido;
  estado.perdido = perdido;
  xSemaphoreGive(trava);
  if (mudou) {
    Serial.printf("[perdido] modo pet perdido %s\n", perdido ? "LIGADO" : "desligado");
    perdidoMudouPeloSite = perdido ? 1 : 0;
  }
}

void publicarEstado(const Estado &e) {
  JsonDocument doc;
  JsonObject f = doc["fields"].to<JsonObject>();
  f["nome"]["stringValue"] = PET_NOME;
  f["lat"]["doubleValue"] = e.lat;
  f["lng"]["doubleValue"] = e.lng;
  f["gpsFix"]["booleanValue"] = e.gpsFix;
  f["satelites"]["integerValue"] = String(e.satelites);
  f["batimentos"]["integerValue"] = String(e.bpm);
  f["coleiraNoPet"]["booleanValue"] = e.coleiraNoPet;
  f["dentroArea"]["booleanValue"] = e.dentroArea;
  f["distancia"]["doubleValue"] = round(e.distancia);
  f["bateria"]["integerValue"] = String(e.bateriaPct);
  f["modoPerdido"]["booleanValue"] = e.perdido;
  f["bpmRepouso"]["integerValue"] = String(e.bpmRepouso);
  f["emRepouso"]["booleanValue"] = e.emRepouso;
  f["saudeAlerta"]["stringValue"] = e.saudeAlerta > 0 ? "alto" : e.saudeAlerta < 0 ? "baixo" : "";
  xSemaphoreTake(trava, portMAX_DELAY);
  Base b = base;
  xSemaphoreGive(trava);
  f["baseRepouso"]["integerValue"] = String((int)lround(b.media));
  f["baseDesvio"]["doubleValue"] = round(sqrtf(b.var) * 10) / 10.0;
  f["baseDias"]["integerValue"] = String(b.dias);
  String iso = agoraISO();
  if (iso.length()) f["atualizadoEm"]["timestampValue"] = iso;
  String corpo; serializeJson(doc, corpo);
  int cod = requisicao("PATCH", urlFirestore("pets/" PET_ID), corpo);
  Serial.printf("[envio] %d  lat %.6f lng %.6f  bpm %d  noPet %d  dentro %d  bat %d%%\n",
                cod, e.lat, e.lng, e.bpm, e.coleiraNoPet, e.dentroArea, e.bateriaPct);
}

const char *textoEvento(TipoEvento t) {
  switch (t) {
    case SAIU_AREA:        return "saiu da area segura";
    case VOLTOU_AREA:      return "voltou para a area segura";
    case COLEIRA_REMOVIDA: return "esta sem a coleira (coleira removida)";
    case COLEIRA_COLOCADA: return "esta com a coleira de novo";
    case BATIMENTO_ALTO:   return "esta com o batimento em repouso acima do normal dele";
    case BATIMENTO_BAIXO:  return "esta com o batimento em repouso abaixo do normal dele";
    default:               return "esta com a bateria da coleira baixa";
  }
}
const char *codigoEvento(TipoEvento t) {
  const char *c[] = {"saiu_area", "voltou_area", "coleira_removida", "coleira_colocada", "bateria_baixa",
                     "batimento_alto", "batimento_baixo"};
  return c[t];
}

#if TELEGRAM_ATIVO
#include "telegram.h"
#endif

void tratarEvento(const Evento &ev) {
  JsonDocument doc;
  JsonObject f = doc["fields"].to<JsonObject>();
  f["pet"]["stringValue"] = PET_ID;
  f["tipo"]["stringValue"] = codigoEvento(ev.tipo);
  f["mensagem"]["stringValue"] = String(PET_NOME) + " " + textoEvento(ev.tipo);
  f["lat"]["doubleValue"] = ev.lat;
  f["lng"]["doubleValue"] = ev.lng;
  String iso = agoraISO();
  if (iso.length()) f["criadoEm"]["timestampValue"] = iso;
  String corpo; serializeJson(doc, corpo);
  int cod = requisicao("POST", urlFirestore("pets/" PET_ID "/alertas"), corpo);
  Serial.printf("[alerta] %s -> %d\n", codigoEvento(ev.tipo), cod);

#if TELEGRAM_ATIVO
  alertaTelegram(ev.tipo, ev.lat, ev.lng);
#endif

#if WHATSAPP_ATIVO
  if (ev.tipo == SAIU_AREA || ev.tipo == COLEIRA_REMOVIDA || ev.tipo == BATERIA_BAIXA ||
      ev.tipo == BATIMENTO_ALTO || ev.tipo == BATIMENTO_BAIXO) {
    String msg = String("Alerta da coleira: ") + PET_NOME + " " + textoEvento(ev.tipo) + ".";
    if (ev.lat != 0) msg += "\nLocalizacao: https://maps.google.com/?q=" + String(ev.lat, 6) + "," + String(ev.lng, 6);
    String url = "https://api.callmebot.com/whatsapp.php?phone=" + urlEncode(WHATSAPP_TELEFONE) +
                 "&text=" + urlEncode(msg) + "&apikey=" CALLMEBOT_APIKEY;
    int c = requisicao("GET", url, "");
    Serial.printf("[whatsapp] %d\n", c);
  }
#endif
}

// ------------------------------------------------ saude: resumo do dia e o "normal" do pet
String dataLocal() {
  time_t t = time(nullptr);
  if (t < 1700000000) return "";
  struct tm l; localtime_r(&t, &l);
  char b[11]; strftime(b, sizeof(b), "%Y-%m-%d", &l);
  return String(b);
}

void carregarBase() {
  prefs.begin("saude", false);
  base.media = prefs.getFloat("media", 0);
  base.var = prefs.getFloat("var", 0);
  base.dias = prefs.getInt("dias", 0);
  Serial.printf("[saude] normal do pet: %.0f bpm (desvio %.1f, %d dias)\n", base.media, sqrtf(base.var), base.dias);
}

// fecha um dia: se teve repouso suficiente, ajusta o normal do pet (media movel de ~7 dias)
void aprenderDia(const Dia &d) {
  if (d.bpmRepousoN < MIN_MINUTOS_REPOUSO_DIA) {
    Serial.printf("[saude] %s: so %d min de repouso medido, nao entra no aprendizado\n", d.data, d.bpmRepousoN);
    return;
  }
  float m = d.bpmRepousoSoma / d.bpmRepousoN;
  xSemaphoreTake(trava, portMAX_DELAY);
  if (base.dias == 0) { base.media = m; base.var = 25; }
  else {
    float a = 1.0f / min(base.dias + 1, 7);
    float delta = m - base.media;
    base.media += a * delta;
    base.var = (1 - a) * (base.var + a * delta * delta);
  }
  base.dias++;
  Base b = base;
  xSemaphoreGive(trava);
  prefs.putFloat("media", b.media);
  prefs.putFloat("var", b.var);
  prefs.putInt("dias", b.dias);
  Serial.printf("[saude] dia %s: repouso %.0f bpm -> normal agora %.0f bpm (%d dias)\n", d.data, m, b.media, b.dias);
}

String urlDia(const char *data) { return urlFirestore(String("pets/" PET_ID "/saude/") + data); }

void publicarDia(const Dia &d) {
  if (!d.data[0]) return;
  JsonDocument doc;
  JsonObject f = doc["fields"].to<JsonObject>();
  f["pet"]["stringValue"] = PET_ID;
  f["data"]["stringValue"] = d.data;
  f["distanciaM"]["integerValue"] = String((long)lround(d.distanciaM));
  f["minutosAtivos"]["integerValue"] = String(d.minutosAtivos);
  f["bpmRepousoSoma"]["integerValue"] = String((long)lround(d.bpmRepousoSoma));
  f["bpmRepousoN"]["integerValue"] = String(d.bpmRepousoN);
  f["bpmRepousoMin"]["integerValue"] = String(d.bpmRepousoMin);
  f["bpmRepousoMax"]["integerValue"] = String(d.bpmRepousoMax);
  String iso = agoraISO();
  if (iso.length()) f["atualizadoEm"]["timestampValue"] = iso;
  String corpo; serializeJson(doc, corpo);
  int cod = requisicao("PATCH", urlDia(d.data), corpo);
  Serial.printf("[saude] %s: %.0f m, %d min ativos, repouso %d min -> %d\n", d.data, d.distanciaM, d.minutosAtivos, d.bpmRepousoN, cod);
}

// se a coleira reiniciou no meio do dia, continua somando de onde parou
void retomarDia(const String &data) {
  String resp;
  if (requisicao("GET", urlDia(data.c_str()), "", &resp) != 200) return;
  JsonDocument doc;
  if (deserializeJson(doc, resp)) return;
  JsonObjectConst f = doc["fields"];
  auto num = [&](const char *k) { double v = lerNumero(f[k]); return isnan(v) ? 0.0 : v; };
  xSemaphoreTake(trava, portMAX_DELAY);
  dia.distanciaM += num("distanciaM");
  dia.minutosAtivos += (int)num("minutosAtivos");
  dia.bpmRepousoSoma += num("bpmRepousoSoma");
  dia.bpmRepousoN += (int)num("bpmRepousoN");
  int mn = (int)num("bpmRepousoMin"), mx = (int)num("bpmRepousoMax");
  if (mn && (!dia.bpmRepousoMin || mn < dia.bpmRepousoMin)) dia.bpmRepousoMin = mn;
  if (mx > dia.bpmRepousoMax) dia.bpmRepousoMax = mx;
  xSemaphoreGive(trava);
  Serial.printf("[saude] retomando %s do Firebase\n", data.c_str());
}

void cuidarDoDia() {
  static unsigned long ultEnvio = 0;
  String hoje = dataLocal();
  if (!hoje.length()) return;
  xSemaphoreTake(trava, portMAX_DELAY);
  bool vazio = !dia.data[0];
  bool virou = !vazio && hoje != dia.data;
  Dia anterior = dia;
  if (vazio) strncpy(dia.data, hoje.c_str(), sizeof(dia.data));
  if (virou) { dia = Dia(); strncpy(dia.data, hoje.c_str(), sizeof(dia.data)); }
  xSemaphoreGive(trava);

  if (vazio) retomarDia(hoje);
  if (virou) { publicarDia(anterior); aprenderDia(anterior); }
  if (virou || ultEnvio == 0 || millis() - ultEnvio > INTERVALO_SAUDE_MS) {
    xSemaphoreTake(trava, portMAX_DELAY);
    Dia copia = dia;
    xSemaphoreGive(trava);
    publicarDia(copia);
    ultEnvio = millis();
  }
}

void tarefaRede(void *) {
  unsigned long ultEnvio = 0, ultConfig = 0;
  bool primeira = true;
  for (;;) {
    if (!conectarWiFi()) { vTaskDelay(pdMS_TO_TICKS(5000)); continue; }
    if (!garantirToken()) { vTaskDelay(pdMS_TO_TICKS(10000)); continue; }

#if TELEGRAM_ATIVO
    static bool telegramPronto = false;
    if (!telegramPronto) { iniciarTelegram(); telegramPronto = true; }
#endif

    if (primeira || millis() - ultConfig > INTERVALO_CONFIG_MS) { buscarArea(); buscarModoPerdido(); ultConfig = millis(); }

    Evento ev;
    while (xQueueReceive(filaEventos, &ev, 0) == pdTRUE) { tratarEvento(ev); ultEnvio = 0; }

    cuidarDoDia();

#if TELEGRAM_ATIVO
    if (perdidoMudouPeloSite >= 0) { avisarPerdidoPeloSite(perdidoMudouPeloSite == 1); perdidoMudouPeloSite = -1; }
    cuidarTelegram();     // le os comandos do bot
#endif

    xSemaphoreTake(trava, portMAX_DELAY);
    Estado copia = estado;
    xSemaphoreGive(trava);
    // Sem chip de dados: a coleira so sincroniza pelo Wi-Fi, no mesmo ritmo dentro ou fora.
    // Se o pet sair da area, o evento SAIU_AREA (com o ponto da saida) fica na fila
    // e e enviado assim que houver Wi-Fi; o LED pisca sozinho enquanto ele estiver fora.
    if (primeira || ultEnvio == 0 || millis() - ultEnvio > INTERVALO_ENVIO_MS) {
      publicarEstado(copia);
      ultEnvio = millis();
    }
    primeira = false;
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

// ================================================= setup / loop
void setup() {
  Serial.begin(115200);
  pinMode(PINO_LED, OUTPUT);
  analogSetPinAttenuation(PINO_BATERIA, ADC_11db);

  trava = xSemaphoreCreateMutex();
  filaEventos = xQueueCreate(10, sizeof(Evento));
  carregarBase();

  SerialGPS.begin(9600, SERIAL_8N1, PINO_GPS_RX, PINO_GPS_TX);

  Wire.begin(PINO_SDA, PINO_SCL);
  sensorOk = sensor.begin(Wire, I2C_SPEED_FAST);
  if (sensorOk) {
    sensor.setup();                    // configuracao padrao da SparkFun (IR + vermelho)
    sensor.setPulseAmplitudeRed(0x0A); // vermelho fraco: so indica que esta ligado
    sensor.setPulseAmplitudeGreen(0);
    Serial.println("[max30102] ok");
  } else {
    Serial.println("[max30102] NAO encontrado - confira SDA/SCL e alimentacao");
  }

  // pisca 3x: ligou
  for (int i = 0; i < 3; i++) { digitalWrite(PINO_LED, 1); delay(120); digitalWrite(PINO_LED, 0); delay(120); }

  xTaskCreatePinnedToCore(tarefaRede, "rede", 16384, nullptr, 1, nullptr, 0);   // TLS do Firebase + Telegram
}

void loop() {
  lerGPS();
  lerSensorCardiaco();
  lerBateria();
  avaliarMinuto();
  atualizarLED();

  // depuracao: mostra o IR para calibrar LIMIAR_PRESENCA_IR
  static unsigned long ult = 0;
  if (millis() - ult > 2000 && sensorOk) {
    ult = millis();
    Serial.printf("[debug] IR %ld  sats %d  fix %d\n", ultimoIR, (int)gps.satellites.value(), gps.location.isValid());
  }
}
