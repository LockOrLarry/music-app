# Stage 1: build client
FROM node:22-alpine AS client-build
WORKDIR /usr/src/client
COPY client/package*.json ./
RUN npm ci
COPY client ./
RUN npm run build

# Stage 2: build server
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /usr/src/app

# Install native build tools and ffmpeg once, up front
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server ./
COPY --from=client-build /usr/src/client/dist ./client/dist

EXPOSE 5000
CMD ["node", "index.js"]
