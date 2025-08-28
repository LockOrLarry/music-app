// File: server/tests/fetchTrackTest.js
const axios = require("axios");
require('dotenv').config({ path: __dirname + '/../.env' });

const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const TRACK_ID = 2143681; // your track ID

async function fetchTrack() {
  try {
    const res = await axios.get("https://api.jamendo.com/v3.0/tracks/", {
      params: { client_id: CLIENT_ID, id: TRACK_ID },
    });
    console.log("Response data:", res.data);
  } catch (err) {
    console.error("Error fetching track:", err.response?.status, err.response?.data || err.message);
  }
}

fetchTrack();
