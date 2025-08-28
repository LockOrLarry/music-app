// File: server/tests/loadTest.js
const { transcode } = require("../routes/ffmpeg");
const axios = require("axios");
require('dotenv').config({ path: __dirname + '/../.env' });

const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const TRACK_ID = 2143681; // example track
const FORMAT = "mp3";
const CONCURRENT_JOBS = 10;

async function fetchTrackData(trackId) {
  const res = await axios.get("https://api.jamendo.com/v3.0/tracks/", {
    params: { client_id: CLIENT_ID, id: trackId },
  });
  console.log(res.data);
  const track = res.data.results[0];
  if (!track || !track.audiodownload_allowed || !track.audiodownload) {
    throw new Error("Track is not downloadable or does not exist");
  }
  return track;
}

async function runJob(id) {
  try {
    const trackData = await fetchTrackData(TRACK_ID);
    const downloadUrl = trackData.audiodownload; // use the actual download URL

    await new Promise((resolve, reject) => {
      transcode(downloadUrl, FORMAT, (err, stream) => {
        if (err) return reject(err);

        let bytes = 0;
        stream.on("data", (chunk) => (bytes += chunk.length));
        stream.on("end", () => resolve(bytes));
        stream.on("error", reject);
      });
    }).then((bytes) => console.log(`Job ${id} ✅ ${bytes} bytes`))
      .catch((err) => console.log(`Job ${id} ❌ ${err.message}`));
  } catch (err) {
    console.log(`Job ${id} ❌ ${err.message}`);
  }
}

async function runLoadTest() {
  const jobs = [];
  for (let i = 1; i <= CONCURRENT_JOBS; i++) {
    jobs.push(runJob(i));
  }
  await Promise.all(jobs);
  console.log("Load test finished.");
}

runLoadTest();
