#pragma once
// =====================================================================
//  Bot do Telegram da coleira
//  Reaproveita o projeto anterior (ESP32 + GPS + UniversalTelegramBot):
//  handleNewMessages, validateSender e sendLocation continuam aqui, agora
//  ligados ao estado da coleira.
//
//  Sem chip de dados: o bot so funciona quando a coleira esta no Wi-Fi
//  (dentro da area segura). Fora dela a coleira nao tem internet; o aviso
//  de saida e enviado com o ultimo ponto registrado e, depois disso, quem
//  encontrar o pet avisa o tutor pelo QR da coleira.
//
//  Botoes do teclado (ou comandos):
//    Localizacao   /localizacao  -> pino no mapa + link, precisao, distancia de casa
//    Status        /status       -> coleira no pet, bateria, batimentos, area
//    Saude         /saude        -> batimento em repouso x normal dele, atividade do dia
//    Pet perdido   /perdido      -> liga o modo pet perdido (LED + site + pagina do QR)
//    Encontrado    /encontrado   -> desliga o modo pet perdido
//  A coleira tambem manda os alertas (saiu da area, coleira removida, bateria,
//  batimento fora do normal) para todos os IDs autorizados.
//
//  Este arquivo e incluido no meio do coleira_esp32.ino (usa estado, trava,
//  requisicao, urlFirestore...). Biblioteca: UniversalTelegramBot (Brian Lough).
// =====================================================================
#include <UniversalTelegramBot.h>

WiFiClientSecure client;                       // cliente do bot (como no projeto anterior)
UniversalTelegramBot bot(TELEGRAM_TOKEN, client);

// IDs permitidos (lidos de TELEGRAM_IDS no config.h, separados por virgula)
#define SENDER_ID_COUNT 5
String validSenderIds[SENDER_ID_COUNT];
int qtdIds = 0;

const String LOCATION = "localizacao";
const String START = "/start";


// ------------------------------------------------ util
void carregarIds() {
  String lista = TELEGRAM_IDS;
  qtdIds = 0;
  while (lista.length() && qtdIds < SENDER_ID_COUNT) {
    int v = lista.indexOf(',');
    String id = v < 0 ? lista : lista.substring(0, v);
    id.trim();
    if (id.length() && id != "SEU_CHAT_ID") validSenderIds[qtdIds++] = id;
    if (v < 0) break;
    lista = lista.substring(v + 1);
  }
  Serial.printf("[telegram] %d ID(s) autorizado(s)\n", qtdIds);
}

boolean validateSender(String senderId) {
  for (int i = 0; i < qtdIds; i++) {
    if (senderId == validSenderIds[i]) return true;
  }
  return false;
}

String chamarTelegram(const char *metodo, JsonDocument &payload) {
  return bot.sendPostToTelegram(String("bot") + TELEGRAM_TOKEN + "/" + metodo, payload.as<JsonObject>());
}

String teclado() {
  return F("[[\"📍 Localização\",\"🐾 Status\"],"
           "[\"❤️ Saúde\"],"
           "[\"🚨 Pet perdido\",\"🏠 Pet encontrado\"]]");
}

String linkMapa(double lat, double lng) {
  return "https://www.google.com/maps?q=" + String(lat, 6) + "," + String(lng, 6);
}

String tempoDesde(unsigned long ms) {
  unsigned long s = ms / 1000;
  if (s < 60) return String(s) + " s";
  if (s < 3600) return String(s / 60) + " min";
  return String(s / 3600) + " h " + String((s % 3600) / 60) + " min";
}

// pino nativo do Telegram
int enviarPino(const String &chatId, double lat, double lng, float precisaoM, int livePeriod = 0) {
  JsonDocument p;
  p["chat_id"] = chatId;
  p["latitude"] = lat;
  p["longitude"] = lng;
  if (precisaoM > 0) p["horizontal_accuracy"] = min(precisaoM, 1500.0f);
  if (livePeriod) p["live_period"] = livePeriod;
  String resp = chamarTelegram("sendLocation", p);
  JsonDocument r;
  if (deserializeJson(r, resp)) return 0;
  return r["result"]["message_id"] | 0;
}

// ------------------------------------------------ localizacao (sendLocation do projeto anterior)
void sendLocation(String chatId) {
  xSemaphoreTake(trava, portMAX_DELAY);
  Estado e = estado;
  Area a = area;
  xSemaphoreGive(trava);

  if (e.lat == 0 && e.lng == 0) {
    bot.sendMessage(chatId, "🛰️ GPS ainda sem sinal desde que a coleira ligou (" + String(e.satelites) +
                    " satélites). Em céu aberto o primeiro sinal leva de 1 a 5 minutos.", "");
    return;
  }

  bool fresca = e.gpsFix;
  enviarPino(chatId, e.lat, e.lng, e.precisaoM);

  String message = fresca ? "📍 Localização atual de " : "📍 Última localização conhecida de ";
  message += PET_NOME;
  message += "\n\n";
  if (!fresca) message += "⚠️ Sem sinal de GPS há " + tempoDesde(millis() - e.fixEm) + "\n";
  message += "Latitude: " + String(e.lat, 6) + "\n";
  message += "Longitude: " + String(e.lng, 6) + "\n";
  message += "Precisão: ~" + String((int)e.precisaoM) + " m · " + String(e.satelites) + " satélites\n";
  if (e.velocidadeKmh >= 1.5) message += "Velocidade: " + String(e.velocidadeKmh, 1) + " km/h\n";
  message += String(e.dentroArea ? "🏠 Dentro" : "🚨 FORA") + " da área segura · " + String((int)e.distancia) +
             " m de casa (limite " + String((int)a.raio) + " m)\n\n";
  message += linkMapa(e.lat, e.lng);

  bot.sendMessage(chatId, message, "");
}

// ------------------------------------------------ status e saude
void enviarStatus(const String &chatId) {
  xSemaphoreTake(trava, portMAX_DELAY);
  Estado e = estado;
  xSemaphoreGive(trava);
  String m = "🐾 Status de " + String(PET_NOME) + "\n\n";
  if (e.perdido) m += "🚨 MODO PET PERDIDO LIGADO\n";
  m += String(e.dentroArea ? "🏠 Dentro" : "🚨 FORA") + " da área segura (" + String((int)e.distancia) + " m de casa)\n";
  m += String(e.coleiraNoPet ? "✅ Coleira no pet" : "⚠️ Coleira REMOVIDA") + "\n";
  m += "❤️ Batimentos: " + (e.coleiraNoPet && e.bpm ? String(e.bpm) + " bpm" : String("sem leitura")) + "\n";
  m += "🔋 Bateria: " + String(e.bateriaPct) + "%\n";
  m += "🛰️ GPS: " + String(e.gpsFix ? "com sinal" : "sem sinal") + " · " + String(e.satelites) + " satélites\n";
  m += "📶 Wi-Fi: " + String(WiFi.RSSI()) + " dBm · ligada há " + tempoDesde(millis());
  bot.sendMessage(chatId, m, "");
}

void enviarSaude(const String &chatId) {
  xSemaphoreTake(trava, portMAX_DELAY);
  Estado e = estado;
  Base b = base;
  Dia d = dia;
  xSemaphoreGive(trava);
  String m = "❤️ Saúde de " + String(PET_NOME) + "\n\n";
  if (b.dias < DIAS_PARA_APRENDER) {
    m += "Aprendendo o normal dele: " + String(b.dias) + " de " + String(DIAS_PARA_APRENDER) + " dias.\n";
  } else {
    float lim = max(max(0.20f * b.media, 3.0f * sqrtf(b.var)), 12.0f);
    m += "Normal dele em repouso: " + String((int)lround(b.media - lim)) + "–" + String((int)lround(b.media + lim)) +
         " bpm (média " + String((int)lround(b.media)) + ")\n";
  }
  if (e.bpmRepouso) {
    m += "Repouso agora: " + String(e.bpmRepouso) + " bpm";
    m += e.saudeAlerta > 0 ? " ⚠️ acima do normal\n" : e.saudeAlerta < 0 ? " ⚠️ abaixo do normal\n" : " ✅\n";
  } else {
    m += e.emRepouso ? "Em repouso, medindo...\n" : "Não está em repouso agora.\n";
  }
  m += "\nHoje: " + String((int)d.distanciaM) + " m percorridos · " + String(d.minutosAtivos) + " min ativos";
  if (d.bpmRepousoN) m += " · repouso médio " + String((int)lround(d.bpmRepousoSoma / d.bpmRepousoN)) + " bpm";
  m += "\n\nÉ acompanhamento de tendência, não diagnóstico.";
  bot.sendMessage(chatId, m, "");
}

// ------------------------------------------------ modo pet perdido pelo Telegram
void definirPerdidoRemoto(bool perdido, const String &chatId) {
  JsonDocument doc;
  JsonObject f = doc["fields"].to<JsonObject>();
  f["perdido"]["booleanValue"] = perdido;
  String iso = agoraISO();
  if (perdido && iso.length()) f["perdidoDesde"]["timestampValue"] = iso;
  else f["perdidoDesde"]["nullValue"] = nullptr;
  String corpo; serializeJson(doc, corpo);
  // updateMask: muda so esses campos e preserva foto, telefone e recado do perfil
  // (encontrado fica fora do corpo, entao e apagado: comeca ou termina uma busca nova)
  int cod = requisicao("PATCH", urlFirestore("perfis/" PET_ID) +
                       "&updateMask.fieldPaths=perdido&updateMask.fieldPaths=perdidoDesde&updateMask.fieldPaths=encontrado", corpo);
  if (cod != 200) { bot.sendMessage(chatId, "Não consegui atualizar o modo perdido (erro " + String(cod) + ").", ""); return; }

  xSemaphoreTake(trava, portMAX_DELAY);
  estado.perdido = perdido;
  double la = estado.lat, ln = estado.lng;
  xSemaphoreGive(trava);

  JsonDocument al;
  JsonObject g = al["fields"].to<JsonObject>();
  g["pet"]["stringValue"] = PET_ID;
  g["tipo"]["stringValue"] = perdido ? "modo_perdido" : "pet_encontrado";
  g["mensagem"]["stringValue"] = perdido ? String("Modo pet perdido ativado para ") + PET_NOME + " (pelo Telegram)"
                                         : String(PET_NOME) + " foi encontrado. Modo perdido desativado (pelo Telegram)";
  g["lat"]["doubleValue"] = la;
  g["lng"]["doubleValue"] = ln;
  if (iso.length()) g["criadoEm"]["timestampValue"] = iso;
  String c2; serializeJson(al, c2);
  requisicao("POST", urlFirestore("pets/" PET_ID "/alertas"), c2);

  if (perdido) {
    bot.sendMessage(chatId, "🚨 Modo pet perdido LIGADO.\nO LED pisca sem parar e a página do QR pede ajuda. "
                            "Quando alguém escanear e avisar, o ponto exato aparece no site.", "");
  } else {
    bot.sendMessage(chatId, "🏠 Que bom! Modo pet perdido desligado.", "");
  }
}

// ------------------------------------------------ mensagens recebidas (handleNewMessages do projeto anterior)
void handleNewMessages(int numNewMessages) {
  for (int i = 0; i < numNewMessages; i++) {
    String chatId = String(bot.messages[i].chat_id);
    String senderId = String(bot.messages[i].from_id);

    if (!validateSender(senderId)) {
      bot.sendMessage(chatId, "Você não possui permissão.\nSeu ID é " + senderId +
                      ". Peça ao tutor para incluí-lo em TELEGRAM_IDS no config.h.", "");
      Serial.printf("[telegram] mensagem de ID nao autorizado: %s\n", senderId.c_str());
      continue;
    }

    String text = bot.messages[i].text;
    text.toLowerCase();

    if (text.equalsIgnoreCase(START) || text.indexOf("ajuda") >= 0 || text.indexOf("menu") >= 0) {
      String message = "Olá! Sou a coleira de " + String(PET_NOME) + " 🐾\n\n";
      message += "Use os botões abaixo:\n";
      message += "📍 Localização: última posição registrada\n";
      message += "🐾 Status: coleira, bateria e área\n";
      message += "❤️ Saúde: batimento em repouso e atividade\n";
      message += "🚨 Pet perdido / 🏠 Pet encontrado";
      bot.sendMessageWithReplyKeyboard(chatId, message, "", teclado(), true);
    }
    else if (text.indexOf(LOCATION) >= 0 || text.indexOf("localiza") >= 0 || text.indexOf("onde") >= 0) {
      sendLocation(chatId);
    }
    else if (text.indexOf("status") >= 0) {
      enviarStatus(chatId);
    }
    else if (text.indexOf("saude") >= 0 || text.indexOf("saúde") >= 0) {
      enviarSaude(chatId);
    }
    else if (text.indexOf("encontrado") >= 0) {
      definirPerdidoRemoto(false, chatId);
    }
    else if (text.indexOf("perdido") >= 0) {
      definirPerdidoRemoto(true, chatId);
    }
    else {
      bot.sendMessageWithReplyKeyboard(chatId, "Não entendi. Use os botões abaixo 👇", "", teclado(), true);
    }
  }
}

// ------------------------------------------------ alertas da coleira -> Telegram
String textoTelegram(TipoEvento t) {
  switch (t) {
    case SAIU_AREA:        return "saiu da área segura!";
    case VOLTOU_AREA:      return "voltou para a área segura.";
    case COLEIRA_REMOVIDA: return "está sem a coleira (coleira removida).";
    case COLEIRA_COLOCADA: return "está com a coleira de novo.";
    case BATIMENTO_ALTO:   return "está com o batimento em repouso acima do normal dele. Observe se está ofegante, agitado ou com calor.";
    case BATIMENTO_BAIXO:  return "está com o batimento em repouso abaixo do normal dele. Observe se está mais quieto que o normal.";
    default:               return "está com a bateria da coleira baixa. Coloque para carregar.";
  }
}

void alertaTelegram(TipoEvento tipo, double lat, double lng) {
  String texto = String(PET_NOME) + " " + textoTelegram(tipo);
  String icone = tipo == SAIU_AREA ? "🚨 " : tipo == VOLTOU_AREA ? "🏠 " : tipo == COLEIRA_REMOVIDA ? "⚠️ " :
                 tipo == COLEIRA_COLOCADA ? "✅ " : tipo == BATERIA_BAIXA ? "🔋 " : "❤️ ";
  String m = icone + texto;
  if (lat != 0) m += "\n" + linkMapa(lat, lng);
  if (tipo == SAIU_AREA) m += "\nÚltimo ponto registrado. Fora da área a coleira fica sem internet: o LED pisca e "
                            "quem encontrar pode avisar você pelo QR.";
  for (int i = 0; i < qtdIds; i++) bot.sendMessage(validSenderIds[i], m, "");
}

// o tutor ligou/desligou o modo perdido pelo site
void avisarPerdidoPeloSite(bool perdido) {
  for (int i = 0; i < qtdIds; i++) {
    if (perdido) {
      bot.sendMessage(validSenderIds[i], "🚨 Modo pet perdido LIGADO pelo site. A página do QR já está pedindo ajuda.", "");
    } else {
      bot.sendMessage(validSenderIds[i], "🏠 Modo pet perdido desligado pelo site.", "");
    }
  }
}

// ------------------------------------------------ chamado pela tarefa de rede (nucleo 0)
void iniciarTelegram() {
  client.setCACert(TELEGRAM_CERTIFICATE_ROOT);   // confere o certificado do Telegram (vem com a biblioteca)
  carregarIds();
  bot.longPoll = 0;
  bot.setMyCommands(F("[{\"command\":\"localizacao\",\"description\":\"Ultima posicao registrada\"},"
                      "{\"command\":\"status\",\"description\":\"Coleira, bateria e area\"},"
                      "{\"command\":\"saude\",\"description\":\"Batimento em repouso e atividade\"},"
                      "{\"command\":\"perdido\",\"description\":\"Ligar o modo pet perdido\"},"
                      "{\"command\":\"encontrado\",\"description\":\"Desligar o modo pet perdido\"}]"));
  for (int i = 0; i < qtdIds; i++)
    bot.sendMessageWithReplyKeyboard(validSenderIds[i], "🐾 Coleira de " + String(PET_NOME) + " ligada e conectada.", "", teclado(), true);
}

void cuidarTelegram() {
  static uint32_t lastCheckTime = 0;
  uint32_t now = millis();
  if (now - lastCheckTime > INTERVALO_TELEGRAM_MS) {
    lastCheckTime = now;
    int numNewMessages = bot.getUpdates(bot.last_message_received + 1);
    while (numNewMessages) {
      handleNewMessages(numNewMessages);
      numNewMessages = bot.getUpdates(bot.last_message_received + 1);
    }
  }
}
