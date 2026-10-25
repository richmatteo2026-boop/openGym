# openGym MCP over HTTP (src/http.js). Build context is the repository root, because the
# server runs the frontend's own training logic (frontend/src/lib) rather than a copy of it.
#   docker compose --profile mcp up -d --build mcp
FROM node:22-alpine
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN cd mcp && npm ci --omit=dev && npm cache clean --force
COPY mcp/src ./mcp/src
COPY frontend/src ./frontend/src
COPY api/coach ./api/coach
# The frontend's package.json carries "type": "module"; without it Node reads lib/*.js as CommonJS.
COPY frontend/package.json ./frontend/package.json
COPY api/package.json ./api/package.json
USER node
ENV OPENGYM_DATA=/data MCP_PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1
CMD ["node", "mcp/src/http.js"]
