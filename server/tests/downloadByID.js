const fs = require("fs");
require('dotenv').config({ path: __dirname + '/../.env' });

const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const TRACK_ID = "2143681";

async function downloadByID() {
  try {
    const trackRes = await fetch(`https://api.jamendo.com/v3.0/tracks/?id=${TRACK_ID}&client_id=${CLIENT_ID}&format=json`);
    console.log("trackId param:", TRACK_ID);

    const data = await trackRes.json();
    if (!data.results || data.results.length === 0) throw new Error("Track not found");

    const track = data.results[0];
    const downloadUrl = track.audio;

    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(`${track.name}.mp3`, Buffer.from(arrayBuffer));

    console.log(`Downloaded "${track.name}" successfully`);
  } catch (err) {
    console.error("Download failed:", err);
  }
}

downloadByID();
