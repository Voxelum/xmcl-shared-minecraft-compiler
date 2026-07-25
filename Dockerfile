FROM node:22-alpine@sha256:1dc0bfbed23e9406de28d48d1c34098d1286ee8553c7c8c0a813cbe229ca7c3a

WORKDIR /app
COPY --chown=10001:10001 package.json ./
COPY --chown=10001:10001 src ./src
USER 10001:10001
ENV HOME=/nonexistent \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "src/worker-server.mjs"]
