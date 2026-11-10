# Signet. Node's built-in SQLite needs Node 22.13 or newer.
FROM node:24-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 TRUST_PROXY=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# The database lives in /data. Mount a persistent volume there or it is lost on every deploy.
# A mounted volume belongs to root, so the container starts as root, hands /data to the
# "node" user, then drops to that user before starting the site.
RUN mkdir -p /data && chown -R node:node /data /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "chown -R node:node \"$DATA_DIR\" && exec setpriv --reuid=node --regid=node --init-groups node server.js"]
