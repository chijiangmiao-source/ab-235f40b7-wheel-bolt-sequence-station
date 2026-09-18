FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./server.js
COPY public ./public

EXPOSE 8080
USER node
CMD ["node", "server.js"]
