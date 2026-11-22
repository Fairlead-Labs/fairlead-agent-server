# The agent server as one container. Configuration: docs/configuration.md.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY playbooks ./playbooks
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server/index.ts"]
