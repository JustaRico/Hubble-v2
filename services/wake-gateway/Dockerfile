FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund 2>&1 | tail -n 5 || npm install --no-audit --no-fund 2>&1 | tail -n 5
COPY src ./src
EXPOSE 8811
ENV WAKE_GW_PORT=8811
CMD ["node", "src/server.mjs"]
