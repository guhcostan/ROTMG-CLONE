# Realm Reborn

MMO bullet-hell cooperativo jogável no browser, inspirado nas mecânicas clássicas
do Realm of the Mad God: morte permanente, classes, reino procedural, deuses,
dungeons instanciadas, loot, cofre, trade entre jogadores, guildas e pets.
Persistência em banco de dados SQLite. Todo o código e a pixel art são originais.

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

## Mecânicas

- **Morte permanente** — morreu, perdeu o personagem. Ele vai para o cemitério
  da conta com nível, fama e causa da morte. Cada conta tem até 3 personagens.
- **6 classes** — Wizard, Archer, Warrior, Priest, Rogue e Knight, cada uma com
  arma, armadura e habilidade próprias (nova arcana, flecha perfurante, berserk,
  cura em área, invisibilidade e investida atordoante).
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
- **Som e reconexão** — efeitos sonoros procedurais via WebAudio (tecla `M`
  silencia) e reconexão automática mantendo o personagem em quedas momentâneas.

## Arquitetura

```
server/
  index.js   HTTP (cliente estático + REST de contas/ranking) e WebSocket
  game.js    Simulação autoritativa: instâncias, IA, combate, XP, loot,
             cofre, trade, guildas, pets
  world.js   Geração de mapas (Nexus, Reino, dungeons)
  data.js    Definições de classes, itens, inimigos e dungeons
  auth.js    Registro/login (scrypt), throttling e criação de personagens
  db.js      Camada SQLite (better-sqlite3, WAL) com migração do JSON legado
public/      Cliente: canvas 2D, sprites procedurais, HUD, minimapa
test/        Teste de fumaça ponta a ponta (npm test)
Dockerfile, docker-compose.yml   Empacotamento para produção
```

O servidor é autoritativo: valida velocidade, cadência de tiro, dano, drops e
todas as operações de cofre/trade. O cliente faz predição local de movimento e
anima projéteis localmente. Dados de contas, personagens, cemitério, cofre e
guildas ficam em SQLite; sessões persistem por 30 dias e sobrevivem a reinícios.

### Banco de dados

Tabelas: `accounts`, `sessions`, `characters`, `graveyard`, `vault`, `guilds`,
`guild_members`. Na primeira inicialização, um `data/db.json` legado (da versão
anterior baseada em arquivo) é migrado automaticamente e renomeado para
`db.json.migrated`.

## Testes

```bash
npm test
```

Sobe o servidor de verdade, cria duas contas, exercita contas, personagens,
cofre, trade, guildas, combate e ranking, e verifica que tudo **persiste no
SQLite após reiniciar o servidor**.

## Próximas ideias

- Ranks intermediários de guilda e banco/cofre compartilhado de guilda.
- Mais dungeons e eventos do mundo (invasões cronometradas).
- Marketplace assíncrono além da troca presencial.
