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
| `ENTER` | Chat (`/nexus`, `/who`) |
| `ESC` ou `R` | Voltar ao Nexus (fuga de emergência) |

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
  Grotto, Cursed Keep e Infernal Depths), cada uma gerada proceduralmente com
  minions e um chefe com padrões de tiro em anel e invocação de lacaios.
- **Loot** — sacolas (marrom/roxa/dourada por raridade) com armas, armaduras,
  anéis e poções em 6 tiers; bosses garantem drops bons.
- **Combate bullet-hell** — servidor autoritativo a 20 ticks/s: padrões de tiro,
  defesa que reduz dano, regeneração por VIT/WIS e cadência por DEX.

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
- Sem trade entre jogadores, pets ou guildas (boas próximas features).
- Sem reconexão automática: caiu, volta pela tela de personagens.
