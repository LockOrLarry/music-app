const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const path = require('path');
const { Buffer } = require('buffer');
require('dotenv').config();

const { transcodeBuffer } = require('./routes/ffmpeg');
const db = require('./db');
const { searchTracks } = require('./routes/jamendo');

const { DynamoDBClient, PutItemCommand, DeleteItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const dynamo = new DynamoDBClient({ region: "ap-southeast-2" });
const FAVOURITES_TABLE = process.env.DYNAMO_FAVOURITES_TABLE;
const PORT = process.env.PORT || 5000;

const app = express();
let client;

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const ssm = new SSMClient({ region: "ap-southeast-2" });

async function getJamendoClientId() {
  const param = await ssm.send(new GetParameterCommand({
    Name: "/group39/JamendoClientID",
    WithDecryption: false
  }));
  return param.Parameter.Value;
}

const DynamoDBStore = require('connect-dynamodb')(session);
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const dynamoClient = new DynamoDBClient({ region: 'ap-southeast-2' });

app.use(session({
  store: new DynamoDBStore({
    client: dynamoClient,
    table: process.env.SESSION_TABLE_NAME || 'jamapp-sessions',
    ttl: 86400
  }),
  secret: process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none',
    httpOnly: true,
    maxAge: 86400000
  }
}));

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

app.use(session({
  secret: process.env.JWT_SECRET || 'some secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const checkAuth = (req, res, next) => {
    req.isAuthenticated = !!req.session.userInfo;
    next();
};

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
            req.session.tokenSet = tokenSet;
            req.session.userInfo = userInfo;
            req.session.save(() => {
              res.redirect("/?loggedin=true");
            });
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

// SPA auth state
app.get('/userinfo', checkAuth, (req, res) => {
  res.json({
    isAuthenticated: !!req.session.userInfo,
    userInfo: req.session.userInfo || {}
  });
});

// --- Jamendo endpoints ---
let CLIENT_ID;
async function startServer() {
  try {
    CLIENT_ID = await getJamendoClientId();
    
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

    console.error('OIDC client initialized successfully');
    app.listen(PORT, () => console.error(`Server running on port ${PORT}`));
  } catch (err) {
    console.error("Startup error:", err);
  }
}
startServer();

// Search tracks
app.get('/search', checkAuth, async (req, res) => {
    try {
        const query = req.query.q || '';
        const results = await searchTracks(query);

        if (req.isAuthenticated) {
            db.run("INSERT INTO searches (user_id, query) VALUES (?, ?)", [req.session.userInfo.sub, query]);
        }

        res.json({ results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/download/:id', checkAuth, async (req, res) => {
    const trackId = req.params.id;
    const format = req.query.format;

    try {
        const trackRes = await fetch(`https://api.jamendo.com/v3.0/tracks/?id=${trackId}&client_id=${CLIENT_ID}&format=json`);
        if (!trackRes.ok) throw new Error(trackRes.statusText);
        const trackData = (await trackRes.json()).results[0];
        if (!trackData) return res.status(404).json({ error: 'Track not found' });

        const audioUrl = trackData.audio;
        const urlParams = new URLSearchParams(new URL(audioUrl).search);
        const originalFormat = urlParams.get('format')?.startsWith('mp3') ? 'mp3' : urlParams.get('format');

        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) throw new Error(audioRes.statusText);

        if (format === originalFormat) {
            res.setHeader("Content-Disposition", `attachment; filename="${trackData.name}.${originalFormat}"`);
            res.setHeader("Content-Type", `audio/${originalFormat}`);
            audioRes.body.pipe(res);
        } else {
            const buffer = Buffer.from(await audioRes.arrayBuffer());
            const transcodedStream = await transcodeBuffer(buffer, format);
            res.setHeader("Content-Disposition", `attachment; filename="${trackData.name}.${format}"`);
            res.setHeader("Content-Type", `audio/${format}`);
            transcodedStream.pipe(res);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- Favourites endpoints ---
app.post('/favourite', checkAuth, async (req, res) => {
  try {
    console.error("*** RJK you have entered /favourite ***")
    if (!req.isAuthenticated) {
      console.error("Favourite attempt without login", { body: req.body });
      return res.status(401).json({ error: 'Not logged in' });
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

// Serve SPA
app.use(express.static(path.join(__dirname, "client/dist")));

const spaRoutes = ['/', '/myfavourites'];
spaRoutes.forEach(route => {
    app.get(route, (req, res) => {
        res.sendFile(path.join(__dirname, "client/dist/index.html"));
    });
});