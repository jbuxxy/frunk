FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json server.js accounts.js mailer.js fetcher.js ./
# The commit this image was built from, shown with the version in the account
# menu. Set by CI; empty for a local build.
ARG FRUNK_BUILD_SHA=""
ENV FRUNK_BUILD_SHA=${FRUNK_BUILD_SHA}
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://127.0.0.1:3000/api/sites || exit 1
CMD ["node", "server.js"]
