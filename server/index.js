  // server/index.js
  const express = require("express");
  const cors = require("cors");
  const path = require("path");
  require("dotenv").config();
  const { transcodeBuffer } = require("./routes/ffmpeg");
  const { Buffer } = require("buffer");
  const jwt = require("jsonwebtoken");
  const db = require("./db");
  const { searchTracks } = require("./routes/jamendo");

  const app = express();
  app.use(cors());
  app.use(express.json());

  const PORT = process.env.PORT || 5000;
  const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
  const JWT_SECRET = process.env.JWT_SECRET;

  app.post("/register", (req, res) => {
    const { email, password } = req.body;
    db.run(
      "INSERT INTO users (email, password) VALUES (?, ?)",
      [email, password],
      function (err) {
        if (err) return res.status(400).json({ error: "User already exists" });
        res.json({ id: this.lastID, email });
      }
    );
  });

  app.post("/login", (req, res) => {
    const { email, password } = req.body;
    db.get(
      "SELECT * FROM users WHERE email = ? AND password = ?",
      [email, password],
      (err, user) => {
        if (err || !user) return res.status(401).json({ error: "Invalid login" });

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
          expiresIn: "1h",
        });
        res.json({ token });
      }
    );
  });

  function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.sendStatus(403);
      req.user = user;
      next();
    });
  }

  app.get("/search", async (req, res) => {
    try {
      const query = req.query.q || "";
      const results = await searchTracks(query);

      if (req.headers.authorization) {
        const token = req.headers.authorization.split(" ")[1];
        try {
          const user = jwt.verify(token, JWT_SECRET);
          db.run("INSERT INTO searches (user_id, query) VALUES (?, ?)", [user.id, query]);
        } catch {
          console.log("Token invalid, skipping DB log");
        }
      }

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/download", async (req, res) => {
    const { trackId, format } = req.query;
    if (!trackId || !format) return res.status(400).json({ error: "Missing trackId/format" });

    try {
      const trackRes = await fetch(`https://api.jamendo.com/v3.0/tracks/?id=${trackId}&client_id=${CLIENT_ID}&format=json`);
      if (!trackRes.ok) throw new Error(`Track info fetch failed: ${trackRes.statusText}`);
      const trackData = (await trackRes.json()).results[0];
      if (!trackData) return res.status(404).json({ error: "Track not found" });

      const audioUrl = trackData.audio;
      const urlParams = new URLSearchParams(new URL(audioUrl).search);
      const originalFormat = urlParams.get("format")?.startsWith("mp3") ? "mp3" : urlParams.get("format");

      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) throw new Error(`Track download failed: ${audioRes.statusText}`);

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

  app.post("/favourite", authenticateToken, (req, res) => {
    const { trackId } = req.body;
    
    if (!trackId) return res.status(400).json({ error: "Missing trackId" });

    const trackIdInt = parseInt(trackId);
    if (isNaN(trackIdInt)) {
      return res.status(400).json({ error: "Invalid trackId" });
    }

    db.run("INSERT INTO favourites (user_id, track_id) VALUES (?, ?)", [req.user.id, trackIdInt], function (err) {
      if (err) {
        console.error("Favourite error:", err);
        return res.status(400).json({ error: "Already favourited or DB error" });
      }
      res.json({ success: true });
    });
  });

  app.post("/unfavourite", authenticateToken, (req, res) => {
    const { trackId } = req.body;
    
    if (!trackId) return res.status(400).json({ error: "Missing trackId" });

    const trackIdInt = parseInt(trackId);
    if (isNaN(trackIdInt)) {
      return res.status(400).json({ error: "Invalid trackId" });
    }

    db.run("DELETE FROM favourites WHERE user_id = ? AND track_id = ?", [req.user.id, trackIdInt], function (err) {
      if (err) {
        console.error("Unfavourite error:", err);
        return res.status(400).json({ error: "DB error" });
      }
      res.json({ success: true });
    });
  });

  app.get('/myfavourites', authenticateToken, async (req, res) => {

    db.all("SELECT track_id FROM favourites WHERE user_id = ?", [req.user.id], async (err, rows) => {
      if (err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: err.message });
      }

      const trackIds = rows.map(r => parseInt(r.track_id)).filter(id => !isNaN(id));
      
      if (!trackIds.length) return res.json({ results: [] });

      try {
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
        console.error("Jamendo fetch error:", err);
        res.status(500).json({ error: "Failed to fetch tracks" });
      }
    });
  });

  app.use(express.static(path.join(__dirname, "client/dist")));

  app.use((req, res) => {
    res.sendFile(path.join(__dirname, "client/dist/index.html"));
  });

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
