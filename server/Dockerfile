# Railnote sync server, with the phone app. Build from the repo root after `npm run build:web`:
#   docker build -f server/Dockerfile -t railnote-sync .
#   docker run -p 8787:8787 -v railnote-sync:/data railnote-sync
FROM node:22-alpine
WORKDIR /app
COPY server/sync-server.mjs ./
COPY dist-web ./web
ENV PORT=8787 DATA=/data WEB=/app/web
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "sync-server.mjs"]
