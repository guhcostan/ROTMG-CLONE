# Deploy grátis no Fly.io

O jogo é um processo Node persistente (Colyseus sobre WebSocket) com banco
**SQLite em disco**. O Fly.io roda isso de graça (free allowance) e oferece
volume persistente — o encaixe certo. O `Dockerfile` e o `fly.toml` deste repo
já estão prontos, incluindo health check em `/health`. O servidor já entrega os
assets com gzip e cache, e o preview de link (WhatsApp/Discord) funciona em
qualquer domínio sem configurar nada.

## Pré-requisitos
- Conta no Fly.io (https://fly.io) — pede cartão para anti-fraude, mas o uso
  abaixo cabe no free allowance.
- `flyctl` instalado:
  ```bash
  curl -L https://fly.io/install.sh | sh      # macOS/Linux
  fly auth login
  ```

## Passo a passo
1. Na pasta do projeto, escolha um nome único de app e ajuste a 1ª linha do
   `fly.toml` (`app = "..."`). Ou deixe o launch sugerir um:
   ```bash
   fly launch --no-deploy --copy-config
   ```
   - Aceite usar o `Dockerfile` existente.
   - Confirme a região (`gru` = São Paulo) ou troque pela mais perto dos jogadores.
   - **Não** crie Postgres/Redis (o jogo usa SQLite).

2. Crie o volume persistente do banco (uma vez só), **na mesma região do app**:
   ```bash
   fly volumes create realm_data --size 1 --region gru
   ```
   1 GB sobra com folga para o `game.db`.

3. Deploy:
   ```bash
   fly deploy
   ```

4. Abra:
   ```bash
   fly open       # ou acesse https://<seu-app>.fly.dev
   ```

## Pontos importantes
- **SQLite = 1 máquina só.** Não escale para 2+ instâncias; o banco é um
  arquivo local, não compartilhado. Mantenha `min_machines_running = 0` e uma
  única VM. Para escalar de verdade no futuro, troque o SQLite por Postgres.
- **Persistência:** o banco fica em `/app/data` (volume `realm_data`). Sem o
  volume montado, as contas somem a cada deploy. O `fly.toml` já monta isso.
- **Scale-to-zero:** com `auto_stop_machines`, a VM dorme quando ninguém joga e
  acorda no próximo acesso (1ª request demora ~1-2s). Economiza o free tier.
- **WebSocket/TLS:** automático. O Fly termina HTTPS e o cliente detecta
  `https` → usa `wss` sozinho (o matchmaking do Colyseus usa o mesmo host e
  porta). Nada a configurar.
- **Monitoramento:** `GET /health` responde `{ok, online, uptimeSec}` — o
  `fly.toml` já registra o check; serve também para UptimeRobot e afins.
- **Backup:** `fly ssh console -C "cp /app/data/game.db /tmp"` e
  `fly ssh sftp get /tmp/game.db` — ou simplesmente confie no volume.

## Se o build falhar no better-sqlite3
O `npm ci` baixa um binário pré-compilado; costuma funcionar no `node:22-slim`.
Se reclamar de compilação, adicione build tools ao `Dockerfile` antes do
`npm ci`:
```dockerfile
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
```

## Alternativa rápida (demo descartável)
**Render free**: conecta o repo, build pelo `Dockerfile`, porta 8080. Sobe na
hora, mas dorme após 15 min e **perde o SQLite no redeploy** (disco free é
efêmero). Bom para mostrar, ruim para guardar progresso.
