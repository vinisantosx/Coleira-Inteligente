# Vitalar: saúde, localização, segurança e cuidado do pet

<img src="site/icones/icone.svg" alt="Logo do Vitalar: plaquinha de coleira com batimento e pata" width="96" />

**Vitalar** (vital + lar) é um projeto IoT de coleira inteligente: acompanha a saúde do pet, confere se ele está em casa, na área segura, e ajuda quem o encontrar a devolvê-lo.

Coleira com ESP32, GPS NEO-6M, sensor MAX30102 (batimentos e detecção de coleira no pet) e LED de alerta.
O foco desta versão é **monitorar os sinais do pet e conferir se ele está na zona segura**. A coleira sincroniza pelo Wi-Fi de casa com o Firebase (Firestore): batimentos, saúde comparada com o normal dele, coleira no pet, bateria e posição dentro da área.

**Sem localização em tempo real fora da área.** A coleira não tem chip de dados. Quando o pet sai da área, ela registra o ponto e a hora da saída, envia esse aviso e o LED passa a piscar. A partir daí, o diferencial é o **QR da coleira**: quem encontrar o pet escaneia, conta como ele está, envia a localização exata do próprio celular e conversa com o tutor pelo site. Rastreamento em tempo real (4G/LTE-M) fica como melhoria futura.

```
ESP32 (coleira) ──Wi-Fi──> Firestore <──> Site do tutor (Leaflet)
  sinais vitais,              ^
  área segura, saída          └── Página do QR (celular de quem achou o pet):
                                   localização exata, estado do pet, foto, conversa
```

## Pastas

| Pasta | Conteúdo |
|---|---|
| `modelo3d/` | STLs para imprimir, `coleira.py` (modelo paramétrico) e `coleira_montada.glb` (montagem) |
| `firmware/coleira_esp32/` | Código da ESP32 (`coleira_esp32.ino`, `config.h`, `telegram.h`, `certificados.h`) |
| `site/` | Painel do tutor (`index.html`, `script.js`), página do QR (`perdido.html`), rede do bairro para vizinhos (`bairro.html`), login (`conta.js`), dados (`perfil-dados.js`, `encontros.js`, `comunidade.js`, `comunidade-ui.js`) e `firestore.rules` |

## 1. Site: rodar já, sem coleira

1. Abra a pasta `site/` no VS Code e rode com a extensão **Live Server**. Como o `script.js` é um módulo, abrir o `index.html` com dois cliques não funciona.
2. Sem o Firebase configurado, o site entra em **modo simulação**. Use os botões "Simular fora da área", "Remover / colocar coleira" e "Iniciar fuga simulada".
3. Para mudar a casa, clique em "Mover casa" e depois no mapa, ou arraste a casinha. Ajuste o raio e clique em "Salvar área".
   - **Desfazer** (ou Ctrl+Z) volta uma alteração por vez, e **Cancelar** descarta todas as alterações.
   - Os alertas só passam a usar a nova área depois de salvar.
   - Depois de salvar, um aviso com **Desfazer** fica alguns segundos na tela e restaura a área anterior.

## 2. Firebase (com login e regras de segurança)

1. Use o projeto que vocês já criaram (ou crie um em console.firebase.google.com), com o **Firestore Database** ativado.
2. Em *Authentication > Sign-in method*, ative **E-mail/senha** (tutores e vizinhos) e **Anônimo** (coleira e quem escaneia o QR, sem pedir dados).
3. Em *Firestore > Regras*, cole o conteúdo de `site/firestore.rules` e publique.
4. Em *Configurações do projeto > Seus apps*, copie o `firebaseConfig` para `site/firebase-config.js`.
5. **Troque o `PET_ID`** (no `firebase-config.js` e no `config.h`) por algo difícil de adivinhar, por exemplo `rex-7k2q9m`. O primeiro a entrar no painel vira o dono do pet.
6. Abra o site e **crie a sua conta**. Ela fica registrada como dona do pet em `acesso/{PET_ID}`. Os botões da área de testes continuam funcionando e gravam no Firestore como se fossem a coleira.
7. Grave o firmware, abra o Monitor Serial e copie a linha **UID DA COLEIRA**. No site, vá em *Área de testes > Vincular a coleira* e cole. A partir daí só essa coleira (e você) gravam os dados do pet.

### Quem pode ver o quê

| Dado | Onde | Quem lê | Quem grava |
|---|---|---|---|
| Dono e coleira vinculada | `acesso/{pet}` | tutor | tutor |
| Estado da coleira (posição, batimentos, bateria) | `pets/{pet}` | tutor e coleira | coleira (e tutor pela área de testes) |
| Área segura, saúde, alertas | `pets/{pet}/config`, `/saude`, `/alertas` | tutor e coleira | coleira e tutor |
| Encontros pelo QR | `pets/{pet}/encontros` | tutor e quem criou | quem achou cria; tutor e quem achou conversam |
| Perfil do QR (nome, foto, recado, telefone, perdido) | `perfis/{pet}` | qualquer pessoa, só pelo id (não dá para listar) | tutor; a coleira só muda `perdido` |
| Rede do bairro | `vizinhos`, `bairro`, `denuncias` | ver "Rede de alerta do bairro" | |

A posição da coleira em casa revela o endereço, por isso ela nunca é pública. As regras foram testadas no emulador do Firebase com 76 casos (estranho, quem achou o pet, vizinho, coleira antiga, campos extras), e o site foi testado de ponta a ponta contra os emuladores.

**Testar com os emuladores (opcional):** `npx firebase emulators:start --only firestore,auth` (Firestore na porta 8089, Auth na 9099) e abra o site em `localhost` com `?emulador` no endereço.

## Modo pet perdido

1. No painel, em **Perfil e QR da coleira**, coloque a foto, o WhatsApp do tutor e um recado para quem encontrar o pet (cuidados, remédios, temperamento). Depois clique em **Salvar perfil**.
2. Clique em **Baixar QR**, imprima com 22 × 22 mm e cole no rebaixo da tampa. Gere o QR pelo site **publicado**: aberto pelo Live Server, ele aponta para um endereço que só existe no seu computador.
3. Se o pet sumir, clique em **Ativar modo perdido** e confirme. A partir daí:
   - o LED da coleira pisca em dupla, sem parar (fora da área ele já pisca sozinho);
   - a página do QR (`perdido.html`) mostra "Estou perdido!" e pede ajuda;
   - o botão **Pedir ajuda no WhatsApp** monta uma mensagem com a última posição e o link da página do QR, para mandar a vizinhos e grupos do bairro.
4. Quem escaneia o QR informa como o pet está (bem, assustado, machucado), onde ele vai ficar (comigo, no local, levei a um lugar), uma mensagem, nome, telefone e uma foto opcional. Ao tocar em **Avisar o tutor**, a página pega a **localização exata do celular** e cria um *encontro*.
5. **O status do pet muda para "Pet encontrado"** no painel (menu, faixa do topo, cartão do modo perdido e Início), com nome, telefone, hora, estado do pet e onde ele está de quem confirmou. Quem escanear o QR depois vê "Já me encontraram! Meu tutor foi avisado". O painel avisa na hora (som e notificação) e mostra o cartão do encontro no Início e em Pet perdido: ponto exato no mapa com o círculo de precisão, **Traçar rota até lá**, WhatsApp e ligação, estado do pet, foto e uma **conversa** com quem encontrou (respostas rápidas como "Estou a caminho!"). A pessoa vê as respostas na própria página do QR e pode atualizar a localização se mudar de lugar.
6. Quando estiver com o pet, clique em **Já estou com ele** (faixa do topo, cartão ou modo perdido). Os encontros são encerrados, o modo perdido desliga, o alerta do bairro é encerrado, o aviso some de todas as telas e a página do QR agradece. O histórico de alertas registra quem encontrou.

Fora da área, o painel mostra o aviso "saiu da área segura" com a hora e o **último ponto registrado**, além dos atalhos **Ativar modo perdido**, **Pedir ajuda no WhatsApp** e **Ocultar aviso** (esconde o aviso até a próxima saída).

No modo simulação, abra o painel e a `perdido.html` em duas abas do mesmo navegador: uma conversa com a outra. O botão "Alguém encontrou o pet", na área de testes, simula um encontro. Na simulação, quando o pet sai da área, a coleira para de sincronizar (como faria sem Wi-Fi) até ele voltar.

Coleções: `perfis/{pet}` (perfil público e o campo `perdido`), `encontros/{id}` (pet, lat, lng, precisao, achador {nome, telefone}, mensagem, estadoPet, ondeFica, foto, status aberto/a_caminho/resolvido, respostas [{de, texto, em}]) e avisos do tipo `avistamento` em `alertas`. Atualize as regras com o novo `site/firestore.rules`.

**Privacidade:** a página do QR é pública e mostra o telefone cadastrado. Coloque só o número que você aceita divulgar. Nome e telefone de quem encontrou ficam visíveis apenas para o tutor.

## App no celular (PWA)

O site pode ser instalado como app, sem loja:

- **Android e computador (Chrome ou Edge):** botão **Instalar app** na barra lateral e em Configurações.
- **iPhone (Safari):** Compartilhar > Adicionar à Tela de Início (o passo a passo aparece em Configurações).

Instalado, ele abre pela tela inicial em tela cheia, com o ícone do Vitalar (a plaquinha com batimento), e tem atalhos para Mapa, Pet perdido e Rede do bairro (toque longo no ícone, no Android). Sem internet, abre com os últimos dados salvos e mostra "Sem internet" até a conexão voltar.

Arquivos: `site/manifest.webmanifest` (nome, cores, ícones), `site/sw.js` (guarda o site para abrir offline: arquivos do site pela rede primeiro, bibliotecas e mapa pela cópia salva; dados do Firebase nunca passam por ele), `site/pwa.js` (instalação e aviso de versão nova) e `site/icones/`. Com Firebase, os dados ficam guardados no aparelho pelo próprio Firestore (`persistentLocalCache`). Ao publicar uma versão nova, o app mostra "Há uma versão nova do site. Atualizar".

Para testar localmente sem o service worker, abra com `?semsw` no endereço. Próximo passo: notificações push com o app fechado (Firebase Cloud Messaging + Cloud Functions, plano Blaze).

## Configurações

No menu **Configurações** o tutor edita:

- **Pet:** foto, nome, espécie (cão, gato ou outro), raça, porte, cor e sinais, cuidados importantes e recado. Isso aparece na página do QR, para quem encontrar confirmar que é o pet certo. Em **Só você vê** ficam nascimento (o site calcula a idade), peso, sexo, castrado, microchip e veterinário, guardados em `pets/{pet}/config/ficha`.
- **Você:** nome, WhatsApp e se o WhatsApp aparece ou não na página do QR. Com Firebase, mostra o e-mail da conta e envia o link para trocar a senha. Fica em `tutores/{uid}`, que só o próprio tutor lê.
- **Aparência:** quatro paletas (Parque, Lavanda, que é a da primeira versão, Céu e Caramelo), o que mostrar quando não há foto (mascote cão ou gato pela espécie, ou a inicial), topo colorido na cor do estado, fundo com patinhas, títulos com letra arredondada, texto maior e reduzir animações. Muda na hora, fica salvo no navegador e, com Firebase, na conta (vale em outro aparelho).

Depois de atualizar o site, publique de novo o `site/firestore.rules` no Firebase: ele inclui `tutores` e os campos novos do perfil.

## Rede de alerta do bairro

Vizinhos que ajudam a trazer pets de volta. Fica no menu **Rede do bairro** do painel e em `bairro.html`, para quem não tem a coleira (o link vai no rodapé da página do QR e no botão **Convidar vizinhos**).

- **Entrar na rede:** apelido, bairro, região aproximada (pela localização do celular ou pela área segura) e raio de alerta de 1 a 3 km. Só é preciso aceitar as regras: não pedir dinheiro, não expor endereços e só publicar alertas verdadeiros.
- **Alerta do bairro:** ao ativar o modo perdido, o alerta é publicado sozinho (dá para desligar) para os vizinhos num raio de até 3 km. Ele mostra foto, nome, descrição e um círculo de ~1 km, nunca o endereço nem a posição da coleira.
- **Estou procurando:** o vizinho avisa que está ajudando; o tutor vê os apelidos.
- **Vi este pet:** envia a localização exata de onde viu e uma nota. **Só o tutor vê o ponto**, no mapa da rede, com rota.
- **Está comigo:** abre a página do QR do pet e segue o fluxo do encontro (status "Pet encontrado").
- **Compartilhar:** mensagem pronta para o WhatsApp do bairro, com o link público do QR.
- **Encerramento automático:** quando o tutor marca que está com o pet, o alerta sai da lista e entra no contador "pets que voltaram para casa".
- **Segurança:** dicas contra golpes (nunca pagar adiantado, pedir foto na hora, entrega em lugar público) e botão **Denunciar**, que grava em `denuncias` para moderação pelo console.

Como a privacidade é garantida (nas regras, não só na tela):

| Coleção | O que guarda | Quem lê |
|---|---|---|
| `vizinhos/{uid}` | apelido, bairro, quadrícula de ~1 km (`celula`), raio | só o próprio vizinho |
| `bairro/{pet}` | alerta: nome, foto, descrição, bairro, quadrícula, status | vizinhos da rede e o tutor |
| `bairro/{pet}/ajudantes/{uid}` | apelido de quem está procurando | vizinhos e o tutor |
| `bairro/{pet}/avistamentos/{id}` | ponto exato, nota | só o tutor e quem enviou |
| `denuncias/{id}` | motivo | ninguém pelo app (só o console) |

Só o dono de um pet com coleira pode publicar o alerta desse pet, e só um alerta por pet. A rede exige conta com e-mail (logins anônimos não veem nada). Os pets que estão em casa nunca aparecem.

Na simulação, a rede já vem com dois pets perdidos de exemplo. O botão **Vizinhos ajudando na busca** (área de testes) simula vizinhos procurando e um avistamento do seu pet.

## Saúde comparada com o próprio pet

A coleira aprende como é o batimento em repouso **daquele** pet, em vez de usar limites fixos.

- **Repouso:** a coleira está no pet e ele ficou quase parado por 3 minutos, pelo GPS. Sem GPS, como dentro de casa, ela considera que ele está parado.
- **Minuto ativo:** um minuto em que ele andou mais de 25 m.
- **Distância:** a soma dos deslocamentos maiores que 8 m por minuto. Abaixo disso é tremida do GPS.
- **Resumo do dia:** a cada 5 minutos a coleira envia o resumo para `saude/{pet}_{AAAA-MM-DD}`.
- **Aprendizado:** à meia-noite, se o dia teve pelo menos 30 minutos de repouso medido, a média entra no "normal" do pet. É uma média móvel de cerca de 7 dias, guardada na memória da ESP32, então não se perde ao desligar.
- **Alerta:** depois de 3 dias aprendendo, a coleira avisa (site e WhatsApp) quando o batimento em repouso fica, por 8 a 10 minutos, mais de 20% acima ou abaixo do normal. A margem é maior se o pet costuma variar muito.

No site, a seção **Saúde e atividade** mostra:
- o batimento em repouso de agora contra a faixa normal dele;
- a atividade de hoje contra um dia normal;
- os gráficos dos últimos 14 dias, com os dias mais parados em laranja;
- um resumo em linguagem simples do que mudou.

Para testar sem hardware, use a área de testes: "Gerar 14 dias de histórico" e "Batimento fora do normal". Na simulação, cada segundo conta como 1 minuto da coleira, para acelerar a demonstração.

**Limitações:**
- É acompanhamento de tendência, não diagnóstico: o sensor é óptico e o pelo atrapalha a leitura.
- Sem acelerômetro, o repouso é deduzido pelo GPS. Um MPU6050 deixaria a detecção de repouso, sono e brincadeira muito mais precisa.

## Bot do Telegram (reaproveitado do projeto anterior)

O bot do projeto anterior (ESP32 + GPS + UniversalTelegramBot) agora faz parte da coleira, no arquivo `firmware/coleira_esp32/telegram.h`. Ele usa os mesmos dados que o site e funciona enquanto a coleira está no Wi-Fi.

| Botão / comando | O que faz |
|---|---|
| 📍 Localização · `/localizacao` | Pino da última posição registrada + link, precisão do GPS, distância de casa e se está dentro ou fora da área. |
| 🐾 Status · `/status` | Coleira no pet, batimentos, bateria, GPS, Wi-Fi |
| ❤️ Saúde · `/saude` | Batimento em repouso x normal dele, atividade do dia |
| 🚨 Pet perdido · `/perdido` | Liga o modo pet perdido: LED, site e página do QR |
| 🏠 Pet encontrado · `/encontrado` | Desliga o modo perdido |

A coleira também manda para todos os IDs autorizados os alertas de saída da área (com o último ponto registrado), coleira removida, bateria baixa e batimento fora do normal. Alertas gerados sem Wi-Fi ficam na fila e são enviados quando a coleira volta a conectar.

**Configuração (no `config.h`):**
1. No @BotFather, pegue o token **completo**, no formato `1234567890:AAH...`, e coloque em `TELEGRAM_TOKEN`.
2. Grave a coleira e mande `/start` para o bot: ele responde "Você não possui permissão. Seu ID é ...".
3. Coloque esse ID em `TELEGRAM_IDS`. Para mais de uma pessoa, separe os IDs por vírgula. Grave de novo.

**Biblioteca:** UniversalTelegramBot (Brian Lough), pelo Gerenciador de Bibliotecas. Ela usa o ArduinoJson; com a versão 7 aparecem avisos de "deprecated" na compilação, que podem ser ignorados.

O WhatsApp (CallMeBot) agora vem desligado (`WHATSAPP_ATIVO 0`), porque o Telegram já cobre os alertas. Dá para ligar os dois.

## 3. Firmware (Arduino IDE)

Segurança da coleira: ela entra no Firebase com uma conta anônima própria (o UID aparece no Monitor Serial para vincular no site) e confere o certificado do Google (`certificados.h`) e do Telegram em todas as conexões. Assim, ninguém na mesma rede Wi-Fi consegue se passar pelo servidor e roubar o acesso. Para trocar de coleira, cole o UID da nova; a antiga perde o acesso na hora.

1. Instale a placa **esp32** (Espressif) e escolha "ESP32 Dev Module".
2. Pelo Gerenciador de Bibliotecas, instale **UniversalTelegramBot**, **TinyGPSPlus**, **SparkFun MAX3010x Pulse and Proximity Sensor Library** e **ArduinoJson** (v7).
3. Preencha `config.h`: Wi-Fi, `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY` (os mesmos do site), o token e os IDs do Telegram.
4. Grave e abra o Monitor Serial (115200). A linha `[debug] IR ...` mostra o valor do sensor. Anote o valor com a coleira no pet e fora dele e ajuste `LIMIAR_PRESENCA_IR` entre os dois.

Como funciona: o núcleo 1 lê o GPS, o MAX30102 e a bateria e controla o LED. O núcleo 0 cuida do Wi-Fi e dos envios. Assim, as requisições HTTPS não atrapalham a leitura dos batimentos.

### Como a coleira decide que o pet saiu da área

A cada segundo, o núcleo 1 lê o GPS e calcula a distância até o limite da área segura (hoje, um círculo: centro na casa e o raio salvo no site). Enquanto o pet anda dentro, a posição só atualiza o mapa (envio a cada 10 s pelo Wi-Fi). O aviso sai apenas quando o estado muda, com três proteções contra a imprecisão do GPS (5 a 15 m):

- **Margem:** "saiu" só conta além de raio + 10 m e "voltou" só aquém de raio − 10 m. Parado perto da borda, o pet não gera avisos em sequência. Em áreas pequenas a margem encolhe (no máximo 1/3 do raio).
- **Confirmação:** são precisas 5 leituras boas seguidas do mesmo lado (cerca de 5 s). O ponto enviado no aviso é o da primeira delas, onde o pet cruzou o limite.
- **Leituras ruins não decidem:** com menos de 5 satélites ou HDOP acima de 2,5 (erro de ~12 m ou mais), a posição aparece no mapa mas não muda o estado.

Para ajustar, defina no `config.h` (são opcionais): `MARGEM_AREA_M`, `CONFIRMA_LEITURAS`, `GPS_SATS_MIN` e `GPS_HDOP_MAX`. Dica: deixe o raio **menor que o alcance do Wi-Fi**, para o aviso ser enviado enquanto ainda há sinal.

LED: pisca rápido quando o pet está fora da área (para quem encontrar o pet), dá uma piscada curta a cada 2 s enquanto procura satélites e a cada 5 s quando está tudo bem.

WhatsApp (CallMeBot): salve o número do CallMeBot nos contatos (o número atual está em callmebot.com) e mande "I allow callmebot to send me messages". A resposta traz a apikey.

## 4. Impressão e montagem

Veja o visualizador 3D (lista de materiais, ligações e passo a passo). Resumo: PETG, camada de 0,2 mm, 4 perímetros, 25% de preenchimento, sem suporte. Imprima 4 clipes de cabo.
Para mudar medidas (fita mais larga, outra bateria), edite os parâmetros no topo de `modelo3d/coleira.py` e rode `pip install manifold3d trimesh` e depois `python coleira.py`.

## Limitações do protótipo

- **Sem tempo real fora da área (decisão de projeto):** a coleira só sincroniza pelo Wi-Fi. Fora da área, o site mostra o último ponto registrado e a ajuda vem pelo QR. Melhoria futura: módulo 4G/LTE-M (por exemplo, SIM7080G) ou LoRa para rastrear em tempo real.
- **Bateria:** com 1000 mAh, a autonomia estimada fica entre 8 e 10 h com o GPS sempre ligado.
- **Batimentos:** o sensor é óptico e falha em pelo denso. A leitura é uma estimativa.
- **Tamanho:** o módulo principal (80 × 44 × 27 mm, ~120 g) serve para cães médios e grandes. Para gatos e cães pequenos, use um ESP32-C3 SuperMini e uma bateria menor.
- **Segurança:** login, regras por dono e certificados já estão no projeto. Ainda faltam, para uso aberto ao público: limite de envios por pessoa (App Check ou Cloud Functions, plano Blaze), moderação ativa das denúncias e notificação push com o site fechado (Cloud Messaging). Hoje o aviso de pet perdido perto chega enquanto o site está aberto.
