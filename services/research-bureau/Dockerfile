FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production --no-audit --no-fund 2>&1 | tail -n 3 || true
COPY server.mjs loop.mjs io.mjs ./
COPY job-utility ./job-utility
EXPOSE 8814
ENV HUBBLE_RESEARCH_PORT=8814
CMD ["node", "server.mjs"]
