FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production --no-audit --no-fund 2>&1 | tail -n 3 || true
COPY server.mjs ./
COPY job-utility ./job-utility
EXPOSE 8813
ENV HUBBLE_DESIGN_BUREAU_PORT=8813
CMD ["node", "server.mjs"]
