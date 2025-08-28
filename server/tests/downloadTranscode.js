const fs = require("fs");
require('dotenv').config({ path: __dirname + '/../.env' });
const { transcodeBuffer } = require("../routes/ffmpeg");

const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const TRACK_ID = "2143681";
const TARGET_FORMAT = "ogg";

async function downloadAndTranscode() {
  try {
    // Fetch track info
    const trackRes = await fetch(`https://api.jamendo.com/v3.0/tracks/?id=${TRACK_ID}&client_id=${CLIENT_ID}&format=json`);
    const data = await trackRes.json();
    if (!data.results || data.results.length === 0) throw new Error("Track not found");

    const track = data.results[0];

    // Download track as ArrayBuffer
    const response = await fetch(track.audio);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Transcode directly from buffer
    const transcodedStream = await transcodeBuffer(buffer, TARGET_FORMAT);

    // Save transcoded file
    const filename = `${track.name}.${TARGET_FORMAT}`;
    const writeStream = fs.createWriteStream(filename);
    transcodedStream.pipe(writeStream);
    await new Promise((res, rej) => {
      writeStream.on("finish", res);
      writeStream.on("error", rej);
    });

    console.log(`Transcoded and saved as "${filename}"`);
  } catch (err) {
    console.error("Download/Transcode failed:", err);
  }
}

downloadAndTranscode();
