FROM node:22-alpine@sha256:1dc0bfbed23e9406de28d48d1c34098d1286ee8553c7c8c0a813cbe229ca7c3a

WORKDIR /work
COPY package.json ./
COPY src ./src
USER 10001:10001
ENV HOME=/work \
    NODE_ENV=production
CMD ["node", "src/compiler.mjs"]
