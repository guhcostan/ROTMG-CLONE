FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

# o banco SQLite vive aqui; monte um volume para persistir
VOLUME /app/data
EXPOSE 8080

CMD ["node", "server/index.js"]
