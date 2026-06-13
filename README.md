# Realm Reborn

MMO bullet-hell cooperativo jogável no browser, inspirado nas mecânicas clássicas
do Realm of the Mad God: morte permanente, classes, reino procedural, deuses,
dungeons instanciadas e caça por loot. Todo o código e a pixel art são originais.

## Rodando

```bash
npm install
npm start
```

Abra **http://localhost:8080** (ou defina `PORT`). Crie uma conta (usuário + senha)
e jogue. Abra várias abas/máquinas no mesmo servidor para jogar em grupo —
todos compartilham o mesmo Nexus e o mesmo Reino.

## Como jogar

| Controle | Ação |
|---|---|
| `WASD` / setas | Mover |
| Mouse (segurar botão esquerdo) | Mirar e atirar |
| `ESPAÇO` | Habilidade da classe (gasta MP, mira no cursor) |
| `F` | Entrar em portal próximo |
| `1`–`8` | Usar item do inventário |
| Duplo clique no item | Equipar / usar |
| Arrastar itens | Mover entre inventário, equipamento e loot |
| Botão direito no item | Soltar no chão |
| `ENTER` | Chat (`/nexus`, `/who`, `/trade nome`) |
| `ESC` ou `R` | Voltar ao Nexus (fuga de emergência) |
| `M` | Liga/desliga som |

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
- **Cofre da conta** — baú no Nexus com 16 espaços compartilhados entre os
  personagens da conta; o que está no cofre sobrevive à morte.
- **Troca entre jogadores** — `/trade nome` no Nexus abre uma janela segura com
  confirmação dupla; qualquer mudança na oferta reseta as confirmações.
- **Loot e raridades** — sacolas marrom/roxa/dourada/branca por raridade
  (Comum, Incomum, Raro, Épico, Lendário); armas, armaduras, anéis e poções em
  7 tiers, incluindo lendários únicos (Cajado do Cataclisma, Arco da
  Tempestade, Lâmina dos Reis...); bosses garantem drops bons.
- **Combate bullet-hell** — servidor autoritativo a 20 ticks/s: padrões de tiro
  variados por mob (rajadas, escopetas, snipers, metralhadoras, orbes lentos,
  anéis e espirais), defesa que reduz dano, regeneração por VIT/WIS e cadência
  por DEX.
- **Mini-bosses com escolta** — Bandit Lord, Alpha Dire Wolf, Forest Witch,
  Highland Lich e Demon Prince vagam pelo reino com seu séquito de lacaios e
  derrubam loot acima da média.
- **Som e reconexão** — efeitos sonoros procedurais via WebAudio (tecla `M`
  silencia) e reconexão automática em caso de queda de conexão.
- **Ciclo do reino** — a cada 25 deuses mortos o Reino cai: todos os heróis
  dentro dele são convocados ao Castelo do Rei Demente para a luta final, e um
  novo Reino é gerado com outro seed.
- **Ranking de fama** — top 10 de heróis (vivos e caídos) na tela de
  personagens.

## Arquitetura

```
server/
  index.js   HTTP (cliente estático + REST de contas) e endpoint WebSocket
  game.js    Simulação autoritativa: instâncias, IA, combate, XP, loot
  world.js   Geração de mapas (Nexus, Reino, dungeons)
  data.js    Definições de classes, itens, inimigos e dungeons
  auth.js    Registro/login (scrypt) e sessões
  db.js      Persistência em JSON (data/db.json)
public/      Cliente: canvas 2D, sprites procedurais, HUD, minimapa
test/        Teste de fumaça ponta a ponta (npm test)
```

O cliente faz predição local de movimento e anima projéteis localmente; o
servidor valida velocidade, cadência de tiro, dano e drops.

## Limitações conhecidas

- Persistência em arquivo JSON — suficiente para um servidor de hobby.
- Sem pets ou guildas (boas próximas features).
