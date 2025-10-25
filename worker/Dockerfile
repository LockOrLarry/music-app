FROM node:22-slim

WORKDIR /usr/src/worker

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY worker/package*.json ./
RUN npm install --omit=dev
RUN ln -s /usr/src/worker/node_modules /usr/src/node_modules

COPY shared ../shared
COPY worker/index.js .

ENV NODE_ENV=production

CMD ["node", "index.js"]
