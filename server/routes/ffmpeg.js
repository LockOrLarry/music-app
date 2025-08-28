const ffmpeg = require("fluent-ffmpeg");
const { Readable } = require("stream");

/**
 * Transcode a track from a buffer to the specified format.
 * @param {Buffer} trackBuffer - The original audio data.
 * @param {string} format - Target format (e.g., 'ogg', 'mp3').
 * @returns {Promise<Readable>} - A readable stream of the transcoded track.
 */
function transcodeBuffer(trackBuffer, format) {
  return new Promise((resolve, reject) => {
    try {
      const inputStream = new Readable();
      inputStream.push(trackBuffer);
      inputStream.push(null);

      const command = ffmpeg(inputStream)
        .toFormat(format)
        .outputOptions(
          "-threads 0",                     // use all CPU cores
          format === "mp3" ? "-qscale:a 0" : "-compression_level 12", // max quality
          "-af aresample=resampler=soxr:osf=s32:ocl=fltp" // CPU-heavy resampling
        )
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          reject(err);
        });

      const outputStream = command.pipe();
      resolve(outputStream);
    } catch (err) {
      console.error("Transcoding setup error:", err);
      reject(err);
    }
  });
}

module.exports = { transcodeBuffer };