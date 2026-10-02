FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY server.js accounts.js mailer.js fetcher.js ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://127.0.0.1:3000/api/sites || exit 1
CMD ["node", "server.js"]
