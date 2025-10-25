const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const path = require('path');
const { Buffer } = require('buffer');
const crypto = require('crypto');
const Memcached = require('memcached');
const { promisify } = require('util');
require('dotenv').config();

const { searchTracks } = require('./routes/jamendo');
const { JOB_STATUSES, createJobRecord, getJobRecord } = require('../shared/downloadJobs');

const app = express();
let client;

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const secretsClient = new SecretsManagerClient({ region: "ap-southeast-2" });
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

async function getJwtSecret() {
  const secret = await secretsClient.send(new GetSecretValueCommand({
    SecretId: "Group39/MusicApp"
  }));
  const config = JSON.parse(secret.SecretString);
  return config.JWT_SECRET;
}

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const ssm = new SSMClient({ region: "ap-southeast-2" });

async function getJamendoClientId() {
  const param = await ssm.send(new GetParameterCommand({
    Name: "/jamapp/JamendoClientID",
    WithDecryption: false
  }));
  return param.Parameter.Value;
}

app.use(express.json());
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://jamapp.cab432.com');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

async function getFavouritesTableName() {
  const envFallback =
    process.env.DYNAMO_FAVOURITES_TABLE || process.env.FAVOURITES_TABLE;

  try {
    const param = await ssm.send(new GetParameterCommand({
      Name: "/jamapp/FavouritesTableName",
      WithDecryption: false
    }));
    if (param?.Parameter?.Value) {
      if (envFallback && envFallback !== param.Parameter.Value) {
        console.warn(
          "Favourites table SSM value overrides environment fallback",
          { envFallback, resolved: param.Parameter.Value }
        );
      }
      return param.Parameter.Value;
    }
    if (envFallback) {
      console.warn(
        "Favourites table SSM parameter returned no value; using environment fallback",
        { envFallback }
      );
      return envFallback;
    }
    throw new Error("Favourites table name is not configured");
  } catch (err) {
    const errorCode =
      err?.name ||
      err?.Code ||
      (typeof err?.__type === "string" ? err.__type.split("#").pop() : undefined);

    if (errorCode === "ParameterNotFound" && envFallback) {
      console.warn(
        "Favourites table SSM parameter not found; using environment fallback",
        { envFallback }
      );
      return envFallback;
    }

    console.error("Failed to resolve favourites table name", err);
    throw err;
  }
}

const { DynamoDBClient, PutItemCommand, DeleteItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({ region: "ap-southeast-2" });
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const sqs = new SQSClient({ region: "ap-southeast-2" });
const s3 = new S3Client({ region: "ap-southeast-2" });

let FAVOURITES_TABLE;
const PORT = process.env.PORT;

let jwtSecret;
const MEMCACHED_ENDPOINT = process.env.MEMCACHED_ENDPOINT || "jamapp-logo.km2jzi.cfg.apse2.cache.amazonaws.com:11211";
let memcachedClient;
let memcachedGet;
let memcachedSet;

const ALBUM_ART_LAMBDA = process.env.ALBUM_ART_LAMBDA;
const ALBUM_ART_CACHE_PREFIX = process.env.ALBUM_ART_CACHE_PREFIX || "album_art:";
const parsedAlbumArtTtl = parseInt(process.env.ALBUM_ART_TTL_SECONDS || "300", 10);
const ALBUM_ART_TTL_SECONDS = Number.isFinite(parsedAlbumArtTtl) && parsedAlbumArtTtl > 0 ? parsedAlbumArtTtl : 300;
const parsedAlbumArtWidth = parseInt(process.env.ALBUM_ART_WIDTH || "96", 10);
const ALBUM_ART_WIDTH = Number.isFinite(parsedAlbumArtWidth) && parsedAlbumArtWidth > 0 ? parsedAlbumArtWidth : 96;
const ALBUM_ART_ALLOWED_HOST = process.env.ALBUM_ART_ALLOWED_HOST || "usercontent.jamendo.com";
const ALBUM_ART_USER_AGENT = process.env.ALBUM_ART_USER_AGENT || "jamapp-album-art-proxy";

const DOWNLOAD_JOBS_QUEUE_URL = process.env.DOWNLOAD_JOBS_QUEUE_URL;
const DOWNLOAD_JOBS_TABLE_NAME = process.env.DOWNLOAD_JOBS_TABLE_NAME;
const DOWNLOAD_RESULTS_BUCKET = process.env.DOWNLOAD_RESULTS_BUCKET;
const parsedSignedUrlTtl = parseInt(process.env.DOWNLOAD_RESULTS_URL_TTL_SECONDS || "300", 10);
const DOWNLOAD_RESULTS_URL_TTL_SECONDS = Number.isFinite(parsedSignedUrlTtl) && parsedSignedUrlTtl > 0 ? parsedSignedUrlTtl : 300;

const lambdaClient = ALBUM_ART_LAMBDA
  ? new LambdaClient({ region: process.env.AWS_REGION || "ap-southeast-2" })
  : null;

function ensureDownloadInfraConfigured() {
  if (!DOWNLOAD_JOBS_QUEUE_URL || !DOWNLOAD_JOBS_TABLE_NAME || !DOWNLOAD_RESULTS_BUCKET) {
    throw new Error("Download infrastructure is not configured");
  }
}

async function createDownloadJob(userId, trackId, format) {
  ensureDownloadInfraConfigured();

  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const jobRecord = {
    jobId,
    userId,
    trackId: String(trackId),
    format,
    status: JOB_STATUSES.PENDING,
    createdAt: now,
    updatedAt: now
  };

  await createJobRecord(dynamo, DOWNLOAD_JOBS_TABLE_NAME, jobRecord);

  const message = {
    jobId,
    userId,
    trackId: String(trackId),
    format
  };

  await sqs.send(new SendMessageCommand({
    QueueUrl: DOWNLOAD_JOBS_QUEUE_URL,
    MessageBody: JSON.stringify(message)
  }));

  return jobRecord;
}

async function getDownloadJob(userId, jobId) {
  ensureDownloadInfraConfigured();
  const job = await getJobRecord(dynamo, DOWNLOAD_JOBS_TABLE_NAME, jobId);
  if (!job || job.userId !== userId) {
    return null;
  }
  return job;
}

async function getDownloadUrlFromResultKey(resultKey) {
  const key = resultKey.replace(/^\/+/, "");
  const command = new GetObjectCommand({
    Bucket: DOWNLOAD_RESULTS_BUCKET,
    Key: key
  });
  return getSignedUrl(s3, command, { expiresIn: DOWNLOAD_RESULTS_URL_TTL_SECONDS });
}

function initializeMemcached() {
  if (memcachedClient || !MEMCACHED_ENDPOINT) return;

  memcachedClient = new Memcached(MEMCACHED_ENDPOINT, {
    buffer: true,
    retries: 1,
    retry: 1000,
    remove: true,
    timeout: 5000,
    idle: 5000
  });

  memcachedClient.on("issue", details => console.error("Memcached issue:", details));
  memcachedClient.on("failure", details => console.error("Memcached failure:", details));
  memcachedClient.on("reconnecting", details => console.error("Memcached reconnecting:", details));

  memcachedGet = promisify(memcachedClient.get).bind(memcachedClient);
  memcachedSet = promisify(memcachedClient.set).bind(memcachedClient);
}

async function getLogoBuffer() {
  if (!memcachedGet) {
    initializeMemcached();
  }

  if (!memcachedGet) {
    throw new Error("Memcached client unavailable");
  }

  const logoKey = "jam_png";
  const cachedValue = await memcachedGet(logoKey);

  if (!cachedValue) {
    throw new Error("Logo not found in cache");
  }

  if (Buffer.isBuffer(cachedValue)) {
    return cachedValue;
  }

  try {
    return Buffer.from(cachedValue, "base64");
  } catch (err) {
    console.error("Failed to decode logo from cache:", err);
    return Buffer.from(cachedValue);
  }
}

function sanitizeAlbumImageUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    const allowed = ALBUM_ART_ALLOWED_HOST.toLowerCase();
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      return parsed.toString();
    }
  } catch (err) {
    console.error("Invalid album art URL:", err);
  }
  return null;
}

async function invokeAlbumArtLambda(trackId, imageUrl, cacheKey) {
  if (!lambdaClient || !ALBUM_ART_LAMBDA) {
    throw new Error("Album art lambda not configured");
  }

  const payload = {
    trackId,
    imageUrl,
    cacheKey,
    width: ALBUM_ART_WIDTH,
    ttlSeconds: ALBUM_ART_TTL_SECONDS
  };

  const command = new InvokeCommand({
    FunctionName: ALBUM_ART_LAMBDA,
    Payload: Buffer.from(JSON.stringify(payload))
  });

  const response = await lambdaClient.send(command);

  if (response.FunctionError) {
    throw new Error(`Lambda error: ${response.FunctionError}`);
  }

  const rawPayload = Buffer.from(response.Payload || []).toString() || "{}";
  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch (err) {
    throw new Error("Failed to parse album art lambda response");
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  if (!parsed.base64Image) {
    throw new Error("Album art lambda response missing base64Image");
  }

  return Buffer.from(parsed.base64Image, "base64");
}

async function getAlbumArtBuffer(trackId, imageUrl) {
  if (!trackId) {
    throw new Error("Missing trackId");
  }

  if (!memcachedGet) {
    initializeMemcached();
  }

  if (!memcachedGet) {
    throw new Error("Memcached client unavailable");
  }

  const cacheKey = `${ALBUM_ART_CACHE_PREFIX}${trackId}`;

  let cachedValue;
  try {
    cachedValue = await memcachedGet(cacheKey);
  } catch (err) {
    console.error(`Memcached get failed for ${cacheKey}:`, err);
  }

  if (cachedValue) {
    if (Buffer.isBuffer(cachedValue)) {
      return cachedValue;
    }
    try {
      return Buffer.from(cachedValue, "base64");
    } catch (err) {
      console.error(`Failed to decode cached album art for ${cacheKey}:`, err);
    }
  }

  const sanitizedUrl = sanitizeAlbumImageUrl(imageUrl);
  if (!sanitizedUrl) {
    throw new Error("Invalid album art URL");
  }

  async function fetchDirect() {
    const response = await fetch(sanitizedUrl, {
      headers: { "User-Agent": ALBUM_ART_USER_AGENT }
    });
    if (!response.ok) {
      throw new Error(`Album art fetch failed: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  let buffer;
  if (ALBUM_ART_LAMBDA && lambdaClient) {
    try {
      buffer = await invokeAlbumArtLambda(trackId, sanitizedUrl, cacheKey);
    } catch (err) {
      console.error(`Album art lambda failed for ${trackId}, falling back to direct fetch:`, err);
      buffer = await fetchDirect();
    }
  } else {
    buffer = await fetchDirect();
  }

  if (memcachedSet) {
    memcachedSet(cacheKey, buffer, ALBUM_ART_TTL_SECONDS).catch(err => {
      console.error(`Memcached set failed for ${cacheKey}:`, err);
    });
  }

  return buffer;
}

async function initializeApp() {
    FAVOURITES_TABLE = await getFavouritesTableName();
    jwtSecret = await getJwtSecret();
    
    app.use(session({
        secret: jwtSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: true,
            sameSite: 'none',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000
        }
    }));
}


const checkAuth = (req, res, next) => {
    req.isAuthenticated = !!req.session.userInfo;
    next();
};

function isGoogleUser(userInfo) {
  try {
    const identities = JSON.parse(userInfo.identities || '[]');
    return identities.some(id => id.providerName === 'Google');
  } catch (err) {
    console.error("Failed to parse identities:", err);
    return false;
  }
}


// --- Jamendo endpoints ---
let CLIENT_ID;
async function startServer() {
  try {
    CLIENT_ID = await getJamendoClientId();

    await initializeApp();
    initializeMemcached();
    
    // Manual issuer configuration for Cognito
    const issuer = new Issuer({
      issuer: `https://cognito-idp.ap-southeast-2.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
      authorization_endpoint: `https://${process.env.COGNITO_DOMAIN}/oauth2/authorize`,
      token_endpoint: `https://${process.env.COGNITO_DOMAIN}/oauth2/token`,
      userinfo_endpoint: `https://${process.env.COGNITO_DOMAIN}/oauth2/userInfo`,
      jwks_uri: `https://cognito-idp.ap-southeast-2.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`
    });

    client = new issuer.Client({
      client_id: process.env.COGNITO_CLIENT_ID,
      client_secret: process.env.COGNITO_CLIENT_SECRET,
      redirect_uris: [process.env.COGNITO_REDIRECT_URI],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic'
    });

    // --- OIDC endpoints ---
    app.get('/login', (req, res) => {
        const nonce = generators.nonce();
        const state = generators.state();
        req.session.nonce = nonce;
        req.session.state = state;
        
        // Save session before redirect
        req.session.save((err) => {
            if (err) {
                console.error('Session save error in /login:', err);
                return res.status(500).send('Login error');
            }
            
            const authUrl = client.authorizationUrl({
                scope: 'email openid profile',
                state,
                nonce
            });
            res.redirect(authUrl);
        });
    });

    app.get('/callback', async (req, res) => { 
        console.error("***WAK DEBUG*** Callback endpoint")
        try {
            console.error("Callback received - code:", !!req.query.code, "state:", !!req.query.state);
            
            if (!req.query.code) {
                throw new Error('No authorization code received');
            }

            const tokenSet = await client.callback(
                process.env.COGNITO_REDIRECT_URI,
                req.query,
                { 
                    nonce: req.session.nonce, 
                    state: req.session.state 
                }
            );

            console.error("Token exchange successful");

            req.session.tokenSet = tokenSet;

            const userInfo = await client.userinfo(tokenSet.access_token);
            req.session.userInfo = userInfo;
            req.session.isAuthenticated = true;

            console.error("User info received:", userInfo);

            // Clear OAuth state
            req.session.nonce = null;
            req.session.state = null;

            // Save session and redirect
            req.session.save((err) => {
                if (err) {
                    console.error('Session save error in callback:', err);
                    return res.redirect('/?error=session_save_failed');
                }
                res.redirect('/?loggedin=true');
            });

        } catch (err) {
            console.error('Callback error:', err.message);
            if (err.response) {
                console.error('HTTP error:', err.response.status, await err.response.text());
            }
            res.redirect('/?error=auth_failed');
        }
    });

    app.get("/logout", (req, res) => {
      const redirectAfterLogout = "https://jamapp.cab432.com";
      req.session.destroy(err => {
        if (err) {
          console.error("Session destroy error:", err);
          return res.redirect("/");
        }
        res.clearCookie("connect.sid");
        const logoutUrl = `https://${process.env.COGNITO_DOMAIN}/logout?client_id=${process.env.COGNITO_CLIENT_ID}&logout_uri=${encodeURIComponent(redirectAfterLogout)}`;
        res.redirect(logoutUrl);
      });
    });

    // Search tracks
    app.get('/search', checkAuth, async (req, res) => {
        try {
            const query = req.query.q || '';
            const results = await searchTracks(query);

            res.json({ results });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/album-art', checkAuth, async (req, res) => {
        try {
            const { trackId, imageUrl } = req.query;

            if (!trackId || !imageUrl) {
                return res.status(400).json({ error: 'Missing trackId or imageUrl' });
            }

            const buffer = await getAlbumArtBuffer(String(trackId), String(imageUrl));

            res.setHeader("Content-Type", "image/png");
            res.setHeader("Cache-Control", `public, max-age=${Math.max(ALBUM_ART_TTL_SECONDS, 1)}, must-revalidate`);
            res.send(buffer);
        } catch (err) {
            console.error("Album art retrieval error:", err);
            res.status(503).json({ error: 'Album art unavailable' });
        }
    });

    app.post('/download', checkAuth, async (req, res) => {
      try {
        if (!req.isAuthenticated) {
          return res.status(401).json({ error: 'Not logged in' });
        }

        const { trackId, format } = req.body || {};
        const allowedFormats = ["mp3", "ogg", "wav", "flac"];

        if (!trackId || !format) {
          return res.status(400).json({ error: 'Missing trackId or format' });
        }

        if (!allowedFormats.includes(format)) {
          return res.status(400).json({ error: 'Unsupported format' });
        }

        const job = await createDownloadJob(req.session.userInfo.sub, trackId, format);
        res.status(202).json({ jobId: job.jobId, status: job.status });
      } catch (err) {
        console.error("Error creating download job:", err);
        res.status(503).json({ error: 'Unable to queue download' });
      }
    });

    app.get('/download/:jobId/status', checkAuth, async (req, res) => {
      try {
        if (!req.isAuthenticated) {
          return res.status(401).json({ error: 'Not logged in' });
        }

        const jobId = req.params.jobId;
        const job = await getDownloadJob(req.session.userInfo.sub, jobId);
        if (!job) {
          return res.status(404).json({ error: 'Job not found' });
        }

        const response = {
          jobId: job.jobId,
          status: job.status,
          message: job.message
        };

        if (job.status === JOB_STATUSES.COMPLETED && job.resultKey) {
          response.downloadUrl = await getDownloadUrlFromResultKey(job.resultKey);
        }

        res.json(response);
      } catch (err) {
        console.error("Error retrieving job status:", err);
        res.status(500).json({ error: 'Failed to load job status' });
      }
    });

    // --- Favourites endpoints ---
    app.post('/favourite', checkAuth, async (req, res) => {
      try {
        if (!req.isAuthenticated) {
          console.error("Favourite attempt without login", { body: req.body });
          return res.status(401).json({ error: 'Not logged in' });
        }
        if (!isGoogleUser(req.session.userInfo)) {
          console.error("Access denied: non-Google user", { user: req.session.userInfo });
          return res.status(403).json({ error: 'Only Google users can use favourites' });
        }


        const { trackId } = req.body;
        if (!trackId) {
          console.error("Favourite attempt missing trackId", { body: req.body, user: req.session.userInfo });
          return res.status(400).json({ error: 'Missing trackId' });
        }

        console.error("Adding favourite", { user: req.session.userInfo.sub, trackId });
        await dynamo.send(new PutItemCommand({
          TableName: FAVOURITES_TABLE,
          Item: {
            user_id: { S: req.session.userInfo.sub },
            track_id: { N: String(trackId) }
          }
        }));

        res.json({ success: true });
      } catch (err) {
        console.error("Error in /favourite:", err, { body: req.body, session: req.session.userInfo });
        res.status(500).json({ error: 'Failed to favourite track' });
      }
    });

    app.post("/unfavourite", checkAuth, async (req, res) => {
      try {
        if (!req.isAuthenticated) {
          console.error("Unfavourite attempt without login", { body: req.body });
          return res.status(401).json({ error: 'Not logged in' });
        }
        if (!isGoogleUser(req.session.userInfo)) {
          console.error("Access denied: non-Google user", { user: req.session.userInfo });
          return res.status(403).json({ error: 'Only Google users can use favourites' });
        }

        const { trackId } = req.body;
        if (!trackId) {
          console.error("Unfavourite attempt missing trackId", { body: req.body, user: req.session.userInfo });
          return res.status(400).json({ error: 'Missing trackId' });
        }

        console.error("Removing favourite", { user: req.session.userInfo.sub, trackId });
        await dynamo.send(new DeleteItemCommand({
          TableName: FAVOURITES_TABLE,
          Key: {
            user_id: { S: req.session.userInfo.sub },
            track_id: { N: String(trackId) }
          }
        }));

        res.json({ success: true });
      } catch (err) {
        console.error("Error in /unfavourite:", err, { body: req.body, session: req.session.userInfo });
        res.status(500).json({ error: 'Failed to unfavourite track' });
      }
    });

    app.get('/myfavourites', checkAuth, async (req, res) => {
      try {
        if (!req.isAuthenticated) {
          console.error("Fetching favourites without login");
          return res.status(401).json({ error: 'Not logged in' });
        }
        if (!isGoogleUser(req.session.userInfo)) {
          console.error("Access denied: non-Google user", { user: req.session.userInfo });
          return res.status(403).json({ error: 'Only Google users can use favourites' });
        }

        console.error("Fetching favourites for user", req.session.userInfo.sub);

        const favRes = await dynamo.send(new QueryCommand({
          TableName: FAVOURITES_TABLE,
          KeyConditionExpression: "user_id = :uid",
          ExpressionAttributeValues: {
            ":uid": { S: req.session.userInfo.sub }
          }
        }));

        const trackIds = favRes.Items.map(item => parseInt(item.track_id.N)).filter(id => !isNaN(id));
        if (!trackIds.length) return res.json({ results: [] });

        const trackResults = [];
        for (const trackId of trackIds) {
          try {
            const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${CLIENT_ID}&format=json&id=${trackId}`;
            const response = await fetch(url);
            const data = await response.json();
            if (data.results && data.results.length > 0) {
              trackResults.push({ ...data.results[0], id: parseInt(data.results[0].id) });
            } else {
              console.warn(`No data returned from Jamendo for trackId ${trackId}`);
            }
          } catch (err) {
            console.error(`Error fetching track ${trackId} from Jamendo:`, err);
          }
        }

        res.json({ results: trackResults });
      } catch (err) {
        console.error("DynamoDB query error in /myfavourites:", err, { session: req.session.userInfo });
        res.status(500).json({ error: "Failed to fetch favourites" });
      }
    });

    app.get("/logo", async (req, res) => {
      try {
        const logoBuffer = await getLogoBuffer();
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
        res.send(logoBuffer);
      } catch (err) {
        console.error("Logo retrieval error:", err);
        res.status(503).json({ error: "Logo unavailable" });
      }
    });

    // Serve SPA
    app.use(express.static(path.join(__dirname, "client/dist")));

    const spaRoutes = ['/', '/myfavourites'];
    spaRoutes.forEach(route => {
        app.get(route, (req, res) => {
            res.sendFile(path.join(__dirname, "client/dist/index.html"));
        });
    });

    // SPA auth state
    app.get('/userinfo', checkAuth, (req, res) => {
      res.json({
        isAuthenticated: !!req.session.userInfo,
        userInfo: req.session.userInfo || {}
      });
    });

    console.error('OIDC client initialized successfully');
    app.listen(PORT, () => console.error(`Server running on port ${PORT}`));
  } catch (err) {
    console.error("Startup error:", err);
  }
}
startServer();
