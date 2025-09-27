const axios = require("axios");
require("dotenv").config();

async function getJamendoClientId() {
  const param = await ssm.send(new GetParameterCommand({
    Name: "/group39/JamendoClientID",
    WithDecryption: false
  }));
  return param.Parameter.Value;
}

const JAMENDO_BASE = "https://api.jamendo.com/v3.0";
const CLIENT_ID = getJamendoClientId();

// Search tracks
async function searchTracks(query) {
  const url = `${JAMENDO_BASE}/tracks/?client_id=${CLIENT_ID}&format=jsonpretty&limit=10&search=${encodeURIComponent(query)}`;
  const res = await axios.get(url);
  return res.data.results;
}

// Get stream URL (direct link)
async function getStream(trackId) {
  const url = `${JAMENDO_BASE}/tracks/file/?client_id=${CLIENT_ID}&track_id=${trackId}`;
  const res = await axios.get(url);
  return res.data;
}

module.exports = { searchTracks, getStream };
