FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node *.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node integration ./integration
USER node
EXPOSE 3000
CMD ["node", "src.mjs"]
