# Realm Reborn

MMO bullet-hell cooperativo jogável no browser, inspirado nas mecânicas clássicas
do Realm of the Mad God: morte permanente, classes com desbloqueio por
progressão, reino procedural com ciclo de fechamento e chefe final, deuses,
dungeons instanciadas, status effects, loot com raridades e lendários, bônus de
fama na morte, cofre, trade entre jogadores, guildas e pets. O multiplayer roda
sobre [Colyseus](https://colyseus.io/) (matchmaking, salas e sincronização de
estado), o mundo é renderizado em WebGL com
[three.js](https://threejs.org/) — câmera ortográfica inclinada estilo ROTMG,
paredes extrudadas em 3D, sprites billboard com sombra e projéteis com glow —
e a persistência fica em SQLite. Todo o código e a pixel art são originais; a
interface usa as fontes abertas Press Start 2P e VT323 (licença OFL),
vendorizadas em `public/fonts`.

## Rodando localmente

```bash
npm install
npm start
```

Abra **http://localhost:8080**. Crie uma conta (usuário + senha) e jogue. Abra
várias abas/máquinas no mesmo servidor para jogar em grupo — todos compartilham
o mesmo Nexus e o mesmo Reino.

## Rodando em produção

### Docker (recomendado)

```bash
docker compose up -d --build
```

O servidor sobe na porta 8080 e o banco SQLite é persistido no volume
`realm-data` (`/app/data/game.db`). Para atualizar, `git pull` e rode o comando
de novo.

### Direto no host

```bash
npm ci --omit=dev
PORT=8080 DATA_DIR=/var/lib/realm node server/index.js
```

Use um gerenciador de processo (`pm2`, `systemd`) para reiniciar automaticamente.
Coloque um proxy reverso na frente (nginx/Caddy) para TLS — o cliente detecta
`https` e usa `wss` automaticamente. Exemplo mínimo de nginx com WebSocket:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `8080` | Porta HTTP/WebSocket |
| `DATA_DIR` | `./data` | Pasta do banco SQLite (`game.db`) |

Faça backup copiando a pasta `DATA_DIR` (ou o volume Docker). O banco usa WAL,
então copie também os arquivos `game.db-wal` e `game.db-shm` se o servidor
estiver rodando, ou pare o servidor antes do backup.

## Como jogar

No celular/tablet os controles viram toque automaticamente: polegar esquerdo
é o joystick de movimento, o direito mira e atira, e os botões na borda fazem
habilidade, portal (`F`), fuga ao Nexus e chat. O botão `☰` abre o inventário.
Personagens novos têm **proteção de novato** (menos dano recebido até o nível 6).

| Controle | Ação |
|---|---|
| `WASD` / setas | Mover |
| Mouse (segurar botão esquerdo) | Mirar e atirar |
| `ESPAÇO` | Habilidade da classe (gasta MP, mira no cursor) |
| `F` | Entrar em portal próximo |
| `1`–`8` | Usar item do inventário |
| Duplo clique no item | Equipar / usar / depositar no cofre |
| Clique no item (em troca) | Oferecer/remover da troca |
| Arrastar itens | Mover entre inventário, equipamento e loot |
| Botão direito no item | Soltar no chão |
| `ENTER` | Chat e comandos |
| `ESC` ou `R` | Voltar ao Nexus (fuga de emergência) |
| `M` | Liga/desliga o som |

### Comandos de chat

| Comando | Ação |
|---|---|
| `/who` | Lista jogadores na mesma instância |
| `/nexus` | Volta ao Nexus |
| `/trade <jogador>` | Propõe troca (precisa estar perto) |
| `/guilda criar <nome>` | Cria uma guilda |
| `/guilda convidar <jogador>` | Convida (apenas líder) |
| `/guilda aceitar` | Aceita convite pendente |
| `/guilda info` | Lista membros |
| `/guilda sair` | Sai da guilda |
| `/g <mensagem>` | Chat exclusivo da guilda |
| `/mute <jogador>` / `/desmute` | Silencia alguém (só para você, nesta sessão) |
| `/kick`, `/ban`, `/anuncio` | Moderação (contas listadas em `ADMIN_USERS`) |

Clicar num jogador na lista lateral abre o menu de ações (teleportar, trocar,
convidar para grupo/guilda, silenciar); convites chegam com botões
Aceitar/Recusar. Defina `ADMIN_USERS=seunome` no ambiente para ter poderes de
moderação — contas banidas não conseguem logar.

## Mecânicas

- **Morte permanente** — morreu, perdeu o personagem. Ele vai para o cemitério
  da conta com nível, fama e causa da morte. Cada conta tem até 3 personagens.
  Na morte, a fama ganha bônus por feitos (Matador, Inimigo dos Deuses,
  Explorador de Masmorras, Atributos no Máximo, Bem Equipado, Nível Máximo),
  exibidos na tela de morte.
- **11 classes com desbloqueio** — 6 iniciais (Wizard, Archer, Warrior, Priest,
  Rogue, Knight) e 5 avançadas que destravam ao levar a classe pré-requisito ao
  nível 20: Necromancer (← Wizard), Huntress (← Archer), Paladin (← Warrior),
  Mystic (← Priest) e Trickster (← Rogue). Cada uma tem arma, armadura e
  habilidade próprias — nova arcana, flecha perfurante, berserk, cura em área,
  invisibilidade, investida atordoante, dreno com roubo de vida, armadilha
  lenta, aura de cura+ataque, stasis em massa e teleporte (blink). O desbloqueio
  vem do banco e persiste à morte permanente.
- **Status effects** — tiros de vários inimigos e bosses aplicam condições:
  lentidão, paralisia, sangramento (dano contínuo que ignora defesa), doente
  (sem cura), silenciado (sem mana/habilidade) e fraqueza (ataque reduzido). O
  tome do Priest cura e limpa status dos aliados.
- **Atributos e níveis** — HP/MP/ATT/DEF/SPD/DEX/VIT/WIS crescem até o nível 20;
  depois disso, poções de atributo dropadas pelos deuses maximizam o personagem.
- **Reino procedural** — uma ilha com dificuldade em anéis: praia → planície →
  floresta → montanhas → terras dos deuses no centro. Os inimigos respawnam e
  o reino é compartilhado por todos os jogadores online.
- **Dungeons instanciadas** — inimigos derrubam portais (Goblin Warren, Spider
  Grotto, Cursed Keep, Infernal Depths, Sunken Tomb e Abyssal Rift), cada uma
  gerada proceduralmente com minions e um chefe com padrões de tiro em anel,
  espiral e invocação de lacaios.
- **Ciclo do reino** — a cada 25 deuses mortos o Reino cai: todos os heróis
  dentro dele são convocados ao Castelo do Rei Demente para a luta final, e um
  novo Reino é gerado com outro seed.
- **Mobs e mini-bosses** — ~40 tipos de inimigos pelas bandas; mini-bosses
  (Bandit Lord, Alpha Dire Wolf, Forest Witch, Highland Lich, Demon Prince)
  vagam com seu séquito de lacaios e derrubam loot acima da média.
- **Loot e raridades** — sacolas marrom/roxa/dourada/branca por raridade
  (Comum, Incomum, Raro, Épico, Lendário); armas, armaduras, anéis e poções em
  7 tiers, incluindo lendários únicos (Cajado do Cataclisma, Arco da Tempestade,
  Lâmina dos Reis...); bosses garantem drops bons.
- **Cofre da conta** — baú no Nexus com 16 espaços, compartilhado entre todos os
  personagens da conta; sobrevive à morte permanente.
- **Trade entre jogadores** — proposta segura com confirmação dupla; ninguém
  perde item se a confirmação não for mútua.
- **Guildas** — criação, convites, chat próprio e tag exibida sobre o personagem.
- **Pets** — chocados de ovos misteriosos (drop de bosses), seguem o jogador e
  aceleram a regeneração de HP/MP.
- **Ranking** — leaderboard por fama (vivos e lendas do cemitério) na tela de
  personagens, com contagem de jogadores online.
- **Combate bullet-hell** — servidor autoritativo a 20 ticks/s: padrões de tiro
  variados por mob (rajadas, escopetas, snipers, metralhadoras, orbes lentos,
  anéis e espirais), defesa que reduz dano, regeneração por VIT/WIS e cadência
  por DEX.
- **Comunicação e reconhecimento** — o chat público vira balões de fala sobre a
  cabeça de quem falou (estilo clássico), cada habilidade de classe tem sua
  assinatura visual de cor/partículas, e quando um chefe cai o grupo vê o
  placar de dano ("Dano em Goblin King: A 55%, B 30%...").
- **Modo espectador** — ao morrer, você pode ficar assistindo seus amigos
  (invisível, a câmera segue o aliado mais próximo, por até 90s) em vez de ser
  ejetado na hora. E quando um Reino cai, o servidor anuncia os **maiores
  caçadores de deuses** daquela conquista.
- **Encontros de chefe legíveis** — chefes telegrafam os anéis grandes com uma
  zona de perigo vermelha no chão (~0,8s para sair), a barra de vida do chefe
  aparece no topo da tela durante o encontro, e o painel "Zonas ativas" mostra
  onde os jogadores estão (Reinos e dungeons) em tempo real.
- **Feed global de eventos** — mortes de chefes notáveis, drops lendários,
  invasões, reinos conquistados, níveis máximos e mortes de heróis famosos
  aparecem no chat de todos os jogadores online (em verde-arcano), onde quer
  que estejam.
- **Som e reconexão** — efeitos sonoros procedurais via WebAudio (tecla `M`
  silencia) e reconexão automática mantendo o personagem em quedas momentâneas.

## Arquitetura

```
server/
  index.js   HTTP (cliente estático + REST de contas/ranking) + servidor Colyseus
  room.js    RealmRoom (Colyseus): auth de sessão, entrada/saída de jogadores e
             ponte do protocolo de jogo; estado global sincronizado (online/temporada)
  game.js    Simulação autoritativa: instâncias, IA, combate, XP, loot,
             cofre, trade, guildas, pets
  world.js   Geração de mapas (Nexus, Reino, dungeons)
  data.js    Definições de classes, itens, inimigos e dungeons
  auth.js    Registro/login (scrypt), throttling e criação de personagens
  db.js      Camada SQLite (better-sqlite3, WAL) com migração do JSON legado
public/      Cliente: renderer WebGL 2.5D (three.js) + overlay 2D (HUD,
             nomes, dano, efeitos, minimapa), sprites procedurais
  js/renderer3d.js  Cena three.js: chão texturizado, paredes instanciadas,
             billboards, sombras, bullets aditivos, luz/névoa por ambiente
  vendor/    colyseus.js e three.min.js (vendorizados)
  fonts/     Press Start 2P + VT323 (OFL, vendorizadas)
test/        Teste de fumaça ponta a ponta (npm test)
Dockerfile, docker-compose.yml   Empacotamento para produção
```

O transporte multiplayer é o [Colyseus](https://colyseus.io/): todos os
clientes entram na sala `realm` (`client.joinOrCreate`), o `onAuth` valida o
token de sessão e o personagem, e o protocolo de jogo viaja como mensagens da
sala; a contagem de jogadores online e a temporada ativa são sincronizadas pelo
estado da sala. O servidor continua autoritativo: valida velocidade, cadência
de tiro, dano, drops e todas as operações de cofre/trade. O cliente faz
predição local de movimento, anima projéteis localmente e reconecta sozinho em
quedas momentâneas. Dados de contas, personagens, cemitério, cofre e guildas
ficam em SQLite; sessões persistem por 30 dias e sobrevivem a reinícios.

### Banco de dados

Tabelas: `accounts`, `sessions`, `characters`, `graveyard`, `vault`, `guilds`,
`guild_members`. Na primeira inicialização, um `data/db.json` legado (da versão
anterior baseada em arquivo) é migrado automaticamente e renomeado para
`db.json.migrated`.

## Cliente de terminal (testes e depuração)

```bash
npm run play -- --user nome --pass senha                    # jogar no terminal
node tools/cli.js --host https://seu-app.fly.dev --user x --pass y
node tools/cli.js --bot --quiet                             # bot autônomo (log de eventos)
```

Renderiza o mapa em ASCII colorido com HUD, chat e feed de eventos — WASD move,
`x` liga autofire no inimigo mais próximo, espaço usa a habilidade, `f` portal,
`t` chat, `q` sai. O modo `--bot` atravessa o tutorial, entra no Reino e luta
sozinho; ótimo para testes de carga e para popular o servidor. `GET /health`
expõe `tick.avgMs/maxMs/gapMaxMs` para diagnosticar lag em produção.

## Testes

```bash
npm test
```

Sobe o servidor de verdade, cria duas contas, exercita contas, personagens,
cofre, trade, guildas, combate e ranking, e verifica que tudo **persiste no
SQLite após reiniciar o servidor**.

## Próximas ideias

- Ramo de classe avançado para o Knight (ex.: Samurai com arma "katana" e
  mecânica de expor o inimigo) — completaria o leque de classes.
- Chefe secreto/finale após o Rei Demente (estilo "Wine Cellar").
- Ranks intermediários de guilda e banco/cofre compartilhado de guilda.
- Mais dungeons e eventos do mundo (invasões cronometradas).
- Marketplace assíncrono além da troca presencial.

## Plugin do Claude Code

O arquivo `.claude/settings.json` registra o marketplace do plugin
[ponytail](https://github.com/DietrichGebert/ponytail) e o habilita. É um
plugin de comportamento para agentes de código (regras de minimalismo); pode
exigir reiniciar a sessão do Claude Code para carregar.
