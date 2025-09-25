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

const app = express();
let client;

// --- Initialize OpenID Client ---
async function initializeClient() {
    const issuer = await Issuer.discover('https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_k6WMVcixi');
    client = new issuer.Client({
        client_id: process.env.COGNITO_CLIENT_ID,
        client_secret: process.env.COGNITO_CLIENT_SECRET,
        redirect_uris: [process.env.REDIRECT_URI || 'http://jamapp.cab432.com:5000/callback'],
        response_types: ['code']
    });
}
initializeClient().catch(console.error);

app.use(express.json());
app.use(session({
    secret: 'some secret',
    resave: false,
    saveUninitialized: false
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
    const authUrl = client.authorizationUrl({
        scope: 'email openid profile',
        state,
        nonce
    });
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    try {
        const params = client.callbackParams(req);
        const tokenSet = await client.callback(
            process.env.REDIRECT_URI || 'http://jamapp.cab432.com:5000/callback',
            params,
            { nonce: req.session.nonce, state: req.session.state }
        );
        const userInfo = await client.userinfo(tokenSet.access_token);
        req.session.userInfo = userInfo;
        res.redirect('/');
    } catch (err) {
        console.error('Callback error:', err);
        res.redirect('/');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        const logoutUrl = `https://ap-southeast-2_k6WMVcixi.auth.ap-southeast-2.amazoncognito.com/logout?client_id=${process.env.COGNITO_CLIENT_ID}&logout_uri=${encodeURIComponent(process.env.REDIRECT_URI || 'http://jamapp.cab432.com:5000')}`;
        res.redirect(logoutUrl);
    });
});

// SPA auth state
app.get('/userinfo', checkAuth, (req, res) => {
    res.json({
        isAuthenticated: req.isAuthenticated,
        userInfo: req.session.userInfo || {}
    });
});

// --- Jamendo endpoints ---
const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;

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

// Download individual track
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

// Favourites
app.post('/favourite', checkAuth, async (req, res) => {
  if (!req.isAuthenticated) return res.status(401).json({ error: 'Not logged in' });
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'Missing trackId' });

  await dynamo.send(new PutItemCommand({
    TableName: FAVOURITES_TABLE,
    Item: {
      user_id: { S: req.session.userInfo.sub },
      track_id: { N: String(trackId) }
    }
  }));

  res.json({ success: true });
});

app.post("/unfavourite", checkAuth, async (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'Missing trackId' });

  await dynamo.send(new DeleteItemCommand({
    TableName: FAVOURITES_TABLE,
    Key: {
      user_id: { S: req.session.userInfo.sub },
      track_id: { N: String(trackId) }
    }
  }));
  res.json({ success: true });
});

app.get('/myfavourites', checkAuth, async (req, res) => {
  try {
    const favRes = await dynamo.send(new QueryCommand({
      TableName: FAVOURITES_TABLE,
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: {
        ":uid": { S: req.session.userInfo.sub }
      }
    }));

    const trackIds = favRes.Items.map(item => parseInt(item.track_id.N)).filter(id => !isNaN(id));
    if (!trackIds.length) return res.json({ results: [] });

    const trackPromises = trackIds.map(async (trackId) => {
      try {
        const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${CLIENT_ID}&format=json&id=${trackId}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.results && data.results.length > 0) {
          return data.results[0];
        }
        return null;
      } catch (err) {
        console.error(`Error fetching track ${trackId}:`, err);
        return null;
      }
    });

    const trackResults = await Promise.all(trackPromises);
    const results = trackResults.filter(track => track !== null)
                                .map(track => ({ ...track, id: parseInt(track.id) }));

    res.json({ results });
  } catch (err) {
    console.error("DynamoDB query error:", err);
    res.status(500).json({ error: "Failed to fetch favourites" });
  }
});

// Serve SPA
app.use(express.static(path.join(__dirname, "client/dist")));

// Explicit SPA routes
const spaRoutes = ['/', '/myfavourites'];
spaRoutes.forEach(route => {
    app.get(route, (req, res) => {
        res.sendFile(path.join(__dirname, "client/dist/index.html"));
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
