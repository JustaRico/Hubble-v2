FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production --no-audit --no-fund 2>&1 | tail -n 5 || true
COPY server.mjs ./
EXPOSE 8812
ENV HUBBLE_ESCALATION_PORT=8812
CMD ["node", "server.mjs"]
