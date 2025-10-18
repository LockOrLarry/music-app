const https = require("https");
const { URL } = require("url");
const Memcached = require("memcached");

const MEMCACHED_ENDPOINT = process.env.MEMCACHED_ENDPOINT;
const CACHE_PREFIX = process.env.CACHE_PREFIX || "album_art:";
const DEFAULT_WIDTH = parseInt(process.env.OUTPUT_WIDTH || "96", 10);
const DEFAULT_TTL = parseInt(process.env.CACHE_TTL_SECONDS || "300", 10);
const ALLOWED_HOST = (process.env.ALLOWED_HOST || "usercontent.jamendo.com").toLowerCase();

const memcached = MEMCACHED_ENDPOINT
  ? new Memcached(MEMCACHED_ENDPOINT, {
      buffer: true,
      retries: 1,
      retry: 1000,
      timeout: 2000,
      remove: true,
    })
  : null;

function memoGet(key) {
  if (!memcached) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    memcached.get(key, (err, value) => (err ? reject(err) : resolve(value)));
  });
}

function memoSet(key, value, ttlSeconds) {
  if (!memcached) return Promise.resolve();
  return new Promise((resolve, reject) => {
    memcached.set(key, value, ttlSeconds, err => (err ? reject(err) : resolve()));
  });
}

function validateUrl(rawUrl) {
  if (!rawUrl) {
    throw new Error("Missing imageUrl");
  }
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("Only https image URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== ALLOWED_HOST && !host.endsWith(`.${ALLOWED_HOST}`)) {
    throw new Error(`Host ${host} is not permitted`);
  }
  return parsed.toString();
}

function fetchBuffer(url, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "jamapp-album-art-resizer",
        },
      },
      response => {
        const { statusCode, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirectDepth < 3) {
          response.resume();
          resolve(fetchBuffer(headers.location, redirectDepth + 1));
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Image request failed with status ${statusCode}`));
          return;
        }

        const data = [];
        response.on("data", chunk => data.push(chunk));
        response.on("end", () => resolve(Buffer.concat(data)));
      }
    );

    request.on("error", reject);
    request.end();
  });
}

async function resizeToPng(buffer, width) {
  const sharp = require("sharp");
  return sharp(buffer).resize({ width, height: width, fit: "cover" }).png().toBuffer();
}

function parseEvent(event) {
  if (!event) return {};
  if (typeof event === "string") {
    try {
      return JSON.parse(event);
    } catch {
      return {};
    }
  }
  if (event.body && typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch {
      return {};
    }
  }
  return event;
}

exports.handler = async rawEvent => {
  if (!MEMCACHED_ENDPOINT) {
    throw new Error("MEMCACHED_ENDPOINT env var is required");
  }

  const event = parseEvent(rawEvent);
  const trackId = event.trackId ? String(event.trackId) : null;
  const cacheKey = event.cacheKey || `${CACHE_PREFIX}${trackId || "unknown"}`;
  const requestedWidth = parseInt(event.width || DEFAULT_WIDTH, 10);
  const ttlSeconds = parseInt(event.ttlSeconds || DEFAULT_TTL, 10);

  if (!trackId) {
    throw new Error("trackId is required");
  }

  const width = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : DEFAULT_WIDTH;
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL;

  try {
    const cached = await memoGet(cacheKey);
    if (cached) {
      const buffer = Buffer.isBuffer(cached) ? cached : Buffer.from(cached, "base64");
      return {
        cacheKey,
        width,
        ttl,
        base64Image: buffer.toString("base64"),
        cached: true,
      };
    }
  } catch (err) {
    console.error(`Memcached get failed for ${cacheKey}:`, err);
  }

  const imageUrl = validateUrl(event.imageUrl);
  const originalBuffer = await fetchBuffer(imageUrl);
  const resized = await resizeToPng(originalBuffer, width);

  try {
    await memoSet(cacheKey, resized, ttl);
  } catch (err) {
    console.error(`Memcached set failed for ${cacheKey}:`, err);
  }

  return {
    cacheKey,
    width,
    ttl,
    base64Image: resized.toString("base64"),
    cached: false,
  };
};
