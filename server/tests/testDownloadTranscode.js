const fs = require("fs");
const axios = require("axios");
require('dotenv').config({ path: __dirname + '/../.env' });

const SERVER_URL = "http://localhost:5000/download";
const TRACK_ID = "2143681";
const FORMAT = "ogg";

async function testDownload() {
  try {
    const response = await axios.get(SERVER_URL, {
      params: { trackId: TRACK_ID, format: FORMAT },
      responseType: "arraybuffer",
      validateStatus: null, // don't throw on non-2xx
    });

    if (response.status !== 200) {
      console.error(`Download failed: ${response.status} ${response.statusText}`);
      console.error('Server message:', response.data.toString().slice(0, 200), '...'); // show first 200 chars only
      return;
    }

    fs.writeFileSync(`track.${FORMAT}`, Buffer.from(response.data));
    console.log(`Downloaded track.${FORMAT} successfully`);
  } catch (err) {
    console.error("Download failed:", err.message);
  }
}

testDownload();
