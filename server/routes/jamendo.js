const axios = require("axios");
require("dotenv").config();

const JAMENDO_BASE = "https://api.jamendo.com/v3.0";
const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;

// Search tracks
async function searchTracks(query) {
  const url = `${JAMENDO_BASE}/tracks/?client_id=${CLIENT_ID}&format=jsonpretty&limit=10&search=${encodeURIComponent(query)}`;
  const res = await axios.get(url);
  return res.data.results;
}

// async function canDownloadTrack(trackId) {
//   const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${CLIENT_ID}&id=${trackId}`;
//   const res = await fetch(url);
//   const data = await res.json();
//   return data.results[0]?.audiodownload_allowed === true;
// }


// Get stream URL (direct link)
async function getStream(trackId) {
  const url = `${JAMENDO_BASE}/tracks/file/?client_id=${CLIENT_ID}&track_id=${trackId}`;
  const res = await axios.get(url);
  return res.data;
}

module.exports = { searchTracks, getStream };
