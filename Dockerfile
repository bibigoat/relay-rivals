FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --chown=node:node package.json engine.mjs server.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
