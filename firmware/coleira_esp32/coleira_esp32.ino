/*
  Coleira inteligente para pet - firmware ESP32
  ------------------------------------------------
  Nucleo 1 (loop):  GPS NEO-6M, MAX30102 (batimentos + presenca), LED de alerta, bateria
  Nucleo 0 (tarefa): Wi-Fi, envio ao Firestore (REST), leitura da area segura, alertas WhatsApp

  Bibliotecas (Gerenciador de Bibliotecas da Arduino IDE):
    - TinyGPSPlus                 (Mikal Hart)
    - SparkFun MAX3010x Pulse and Proximity Sensor Library
    - ArduinoJson  v7             (Benoit Blanchon)
  Placa: "ESP32 Dev Module" (pacote esp32 da Espressif 2.x ou 3.x)

  Estrutura no Firestore:
    pets/{PET_ID}        <- estado atual (escrito pela coleira)
    config/area          <- casa e raio (escrito pelo site)
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
};
struct Dia {                   // acumulado do dia (vai para saude/{PET_ID}_{data})
  char   data[11] = "";        // "AAAA-MM-DD" na hora local; vazio ate o NTP sincronizar
  double distanciaM = 0;
  int    minutosAtivos = 0;
  double bpmRepousoSoma = 0;
  int    bpmRepousoN = 0, bpmRepousoMin = 0, bpmRepousoMax = 0;
};
struct Base { float media = 0, var = 0; int dias = 0; };   // o "normal" do pet
struct Area { double lat = CASA_LAT_PADRAO, lng = CASA_LNG_PADRAO, raio = RAIO_PADRAO_M; };

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

void lerGPS() {
  while (SerialGPS.available()) gps.encode(SerialGPS.read());
  static unsigned long ult = 0;
  if (millis() - ult < 1000) return;
  ult = millis();

  bool fix = gps.location.isValid() && gps.location.age() < 5000;
  xSemaphoreTake(trava, portMAX_DELAY);
  Area a = area;
  estado.gpsFix = fix;
  estado.satelites = gps.satellites.isValid() ? gps.satellites.value() : 0;
  if (fix) {
    estado.lat = gps.location.lat();
    estado.lng = gps.location.lng();
    estado.distancia = distanciaMetros(a.lat, a.lng, estado.lat, estado.lng);
    bool dentro = estado.distancia <= a.raio;
    if (dentro != estado.dentroArea) {
      estado.dentroArea = dentro;
      double la = estado.lat, ln = estado.lng;
      xSemaphoreGive(trava);
      enviarEvento(dentro ? VOLTOU_AREA : SAIU_AREA, la, ln);
      return;
    }
  }
  xSemaphoreGive(trava);
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

int requisicao(const char *metodo, const String &url, const String &corpo, String *resposta = nullptr) {
  WiFiClientSecure cli;
  cli.setInsecure();               // prototipo: sem validar certificado
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(cli, url)) return -1;
  http.addHeader("Content-Type", "application/json");
  int cod = corpo.length() ? http.sendRequest(metodo, corpo) : http.sendRequest(metodo);
  if (resposta && cod > 0) *resposta = http.getString();
  http.end();
  return cod;
}

double lerNumero(JsonVariantConst f) {
  if (f["doubleValue"].is<double>()) return f["doubleValue"].as<double>();
  if (f["integerValue"].is<const char *>()) return atof(f["integerValue"].as<const char *>());
  return NAN;
}

void buscarArea() {
  String resp;
  int cod = requisicao("GET", urlFirestore("config/area"), "", &resp);
  if (cod != 200) { Serial.printf("[area] GET %d (usando a area atual)\n", cod); return; }
  JsonDocument doc;
  if (deserializeJson(doc, resp)) return;
  JsonObjectConst f = doc["fields"];
  double la = lerNumero(f["lat"]), ln = lerNumero(f["lng"]), r = lerNumero(f["raio"]);
  if (isnan(la) || isnan(ln) || isnan(r) || r < 5) return;
  xSemaphoreTake(trava, portMAX_DELAY);
  area.lat = la; area.lng = ln; area.raio = r;
  xSemaphoreGive(trava);
  Serial.printf("[area] casa %.6f, %.6f raio %.0f m\n", la, ln, r);
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
  if (mudou) Serial.printf("[perdido] modo pet perdido %s\n", perdido ? "LIGADO" : "desligado");
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
  int cod = requisicao("POST", urlFirestore("alertas"), corpo);
  Serial.printf("[alerta] %s -> %d\n", codigoEvento(ev.tipo), cod);

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

String urlDia(const char *data) { return urlFirestore(String("saude/") + PET_ID + "_" + data); }

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

    if (primeira || millis() - ultConfig > INTERVALO_CONFIG_MS) { buscarArea(); buscarModoPerdido(); ultConfig = millis(); }

    Evento ev;
    while (xQueueReceive(filaEventos, &ev, 0) == pdTRUE) { tratarEvento(ev); ultEnvio = 0; }

    cuidarDoDia();

    xSemaphoreTake(trava, portMAX_DELAY);
    Estado copia = estado;
    xSemaphoreGive(trava);
    unsigned long intervalo = (copia.dentroArea && !copia.perdido) ? INTERVALO_ENVIO_MS : INTERVALO_ALERTA_MS;
    if (primeira || ultEnvio == 0 || millis() - ultEnvio > intervalo) {
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

  xTaskCreatePinnedToCore(tarefaRede, "rede", 12288, nullptr, 1, nullptr, 0);
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
