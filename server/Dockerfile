# Stage 1: Build client
FROM node:22-alpine AS client-build
WORKDIR /usr/src/client

COPY client/package*.json ./
RUN npm install
COPY client ./
RUN npm run build

# Stage 2: Build server
FROM node:22-slim
WORKDIR /usr/src/app

RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm install --build-from-source
COPY server ./

RUN apt-get update && \
    apt-get install -y ffmpeg python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy built client
COPY --from=client-build /usr/src/client/dist ./client/dist

EXPOSE 5000
CMD ["node", "index.js"]
