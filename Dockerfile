FROM node:22-alpine

# su-exec : permet de démarrer en root pour réparer les droits du volume, puis de passer en utilisateur "node".
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json ./
COPY *.js ./
COPY public ./public
RUN rm -f *.test.js seed-demo.js

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/stock.db \
    TRUST_PROXY=1

VOLUME /data
EXPOSE 8080

# Le volume monté sur /data appartient à root : on le rend à l'utilisateur "node" avant de démarrer.
CMD ["sh", "-c", "mkdir -p /data && chown -R node:node /data && exec su-exec node node --disable-warning=ExperimentalWarning server.js"]
