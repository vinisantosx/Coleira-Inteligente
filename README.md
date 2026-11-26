# Coleira inteligente para pet: projeto IoT

Coleira com ESP32, GPS NEO-6M, sensor MAX30102 (batimentos e detecção de coleira no pet) e LED de alerta.
A coleira envia os dados ao Firebase (Firestore). O site mostra a posição, os batimentos e o status da coleira em tempo real e avisa quando o pet sai da área segura. A coleira também manda um alerta no WhatsApp.

```
ESP32 (coleira) ──HTTPS──> Firestore ──tempo real──> Site (Leaflet)
       │                       ^                      │
       └── WhatsApp (CallMeBot)│                      └── salva a área segura (config/area)
                               └──────── a coleira lê a área a cada 1 min
```

## Pastas

| Pasta | Conteúdo |
|---|---|
| `modelo3d/` | STLs para imprimir, `coleira.py` (modelo paramétrico) e `coleira_montada.glb` (montagem) |
| `firmware/coleira_esp32/` | Código da ESP32 (`coleira_esp32.ino` e `config.h`) |
| `site/` | Ferramenta de acompanhamento (`index.html`, `style.css`, `script.js`, `firebase-config.js`) e `firestore.rules` |

## 1. Site: rodar já, sem coleira

1. Abra a pasta `site/` no VS Code e rode com a extensão **Live Server**. Como o `script.js` é um módulo, abrir o `index.html` com dois cliques não funciona.
2. Sem o Firebase configurado, o site entra em **modo simulação**. Use os botões "Simular fora da área", "Remover / colocar coleira" e "Iniciar fuga simulada".
3. Para mudar a casa, clique em "Mover casa" e depois no mapa, ou arraste a casinha. Ajuste o raio e clique em "Salvar área".
   - **Desfazer** (ou Ctrl+Z) volta uma alteração por vez, e **Cancelar** descarta todas as alterações.
   - Os alertas só passam a usar a nova área depois de salvar.
   - Depois de salvar, um aviso com **Desfazer** fica alguns segundos na tela e restaura a área anterior.

## 2. Firebase

1. Use o projeto que vocês já criaram (ou crie um em console.firebase.google.com), com o **Firestore Database** ativado.
2. Em *Firestore > Regras*, cole o conteúdo de `site/firestore.rules` e publique. Essas regras são abertas, servem só para o protótipo.
3. Em *Configurações do projeto > Seus apps*, copie o `firebaseConfig` para `site/firebase-config.js`.
4. Abra o site: o selo muda para **Ao vivo**. Os botões de simulação continuam funcionando e agora gravam no Firestore como se fossem a coleira. Isso serve para testar tudo antes de montar o hardware.

Coleções usadas:

| Documento | Quem escreve | Campos |
|---|---|---|
| `pets/rex` | coleira | `lat`, `lng`, `gpsFix`, `satelites`, `batimentos`, `coleiraNoPet`, `dentroArea`, `distancia`, `bateria`, `atualizadoEm` |
| `config/area` | site | `lat`, `lng`, `raio` |
| `alertas/*` | coleira | `pet`, `tipo`, `mensagem`, `lat`, `lng`, `criadoEm` |

## Modo pet perdido

1. No painel, em **Perfil e QR da coleira**, coloque a foto, o WhatsApp do tutor e um recado para quem encontrar o pet (cuidados, remédios, temperamento). Depois clique em **Salvar perfil**.
2. Clique em **Baixar QR**, imprima com 22 × 22 mm e cole no rebaixo da tampa. Gere o QR pelo site **publicado**: aberto pelo Live Server, ele aponta para um endereço que só existe no seu computador.
3. Se o pet sumir, clique em **Meu pet sumiu** e confirme. A partir daí:
   - o LED da coleira pisca em dupla, sem parar, e a coleira envia a posição a cada 3 s;
   - a página do QR (`perdido.html`) mostra "Estou perdido!" e pede ajuda;
   - o botão **Pedir ajuda no WhatsApp** monta uma mensagem com a última posição e o link da página do QR, para mandar a vizinhos e grupos do bairro.
4. Quem escaneia o QR pode enviar a localização do próprio celular, deixar um recado e o contato, ou chamar o tutor no WhatsApp. O painel avisa na hora, com som e notificação, e marca no mapa um pino azul com um olho.
5. Quando o pet voltar, clique em **Pet encontrado**.

No modo simulação, abra o painel e a `perdido.html` em duas abas do mesmo navegador: uma conversa com a outra. O botão "Alguém encontrou o pet", na área de testes, simula um aviso.

Novas coleções: `perfis/{pet}` (perfil público e o campo `perdido`) e avisos do tipo `avistamento` em `alertas`. Atualize as regras com o novo `site/firestore.rules`.

**Privacidade:** a página do QR é pública e mostra o telefone cadastrado. Coloque só o número que você aceita divulgar.

## 3. Firmware (Arduino IDE)

1. Instale a placa **esp32** (Espressif) e escolha "ESP32 Dev Module".
2. Pelo Gerenciador de Bibliotecas, instale **TinyGPSPlus**, **SparkFun MAX3010x Pulse and Proximity Sensor Library** e **ArduinoJson** (v7).
3. Preencha `config.h`: Wi-Fi, `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY` (os mesmos do site), o telefone e a apikey do CallMeBot.
4. Grave e abra o Monitor Serial (115200). A linha `[debug] IR ...` mostra o valor do sensor. Anote o valor com a coleira no pet e fora dele e ajuste `LIMIAR_PRESENCA_IR` entre os dois.

Como funciona: o núcleo 1 lê o GPS, o MAX30102 e a bateria e controla o LED. O núcleo 0 cuida do Wi-Fi e dos envios. Assim, as requisições HTTPS não atrapalham a leitura dos batimentos.

LED: pisca rápido quando o pet está fora da área (para quem encontrar o pet), dá uma piscada curta a cada 2 s enquanto procura satélites e a cada 5 s quando está tudo bem.

WhatsApp (CallMeBot): salve o número do CallMeBot nos contatos (o número atual está em callmebot.com) e mande "I allow callmebot to send me messages". A resposta traz a apikey.

## 4. Impressão e montagem

Veja o visualizador 3D (lista de materiais, ligações e passo a passo). Resumo: PETG, camada de 0,2 mm, 4 perímetros, 25% de preenchimento, sem suporte. Imprima 4 clipes de cabo.
Para mudar medidas (fita mais larga, outra bateria), edite os parâmetros no topo de `modelo3d/coleira.py` e rode `pip install manifold3d trimesh` e depois `python coleira.py`.

## Limitações do protótipo

- **Wi-Fi:** a coleira só envia dados quando está em uma rede conhecida. Na rua, sem Wi-Fi, o LED continua alertando, mas o site para de receber posições e mostra "sem sinal". Para rastrear fora de casa, o próximo passo é um módulo 4G/LTE-M (por exemplo, SIM7080G) ou LoRa.
- **Bateria:** com 1000 mAh, a autonomia estimada fica entre 8 e 10 h com o GPS sempre ligado.
- **Batimentos:** o sensor é óptico e falha em pelo denso. A leitura é uma estimativa.
- **Tamanho:** o módulo principal (80 × 44 × 27 mm, ~120 g) serve para cães médios e grandes. Para gatos e cães pequenos, use um ESP32-C3 SuperMini e uma bateria menor.
- **Segurança:** as regras do Firestore e a chave no firmware são de protótipo. Antes de uso real, adicione Firebase Auth.
