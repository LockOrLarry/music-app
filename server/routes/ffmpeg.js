const ffmpeg = require("fluent-ffmpeg");
const { Readable } = require("stream");

/**
 * Transcode a track from a buffer to the specified format with max CPU intensity.
 * @param {Buffer} trackBuffer - The original audio data.
 * @param {string} format - Target format (e.g., 'ogg', 'mp3', 'flac', 'wav', 'opus').
 * @returns {Promise<Readable>} - A readable stream of the transcoded track.
 */
function transcodeBuffer(trackBuffer, format) {
  return new Promise((resolve, reject) => {
    try {
      const inputStream = new Readable();
      inputStream.push(trackBuffer);
      inputStream.push(null);

      // choose most CPU-heavy options per codec
      let options = ["-threads 0", "-af aresample=resampler=soxr:osf=s32:ocl=fltp"];
      switch (format) {
        case "mp3":
          options.push("-c:a libmp3lame", "-qscale:a 0"); // highest quality
          break;
        case "ogg":
          options.push("-c:a libvorbis", "-qscale:a 10"); // max vorbis quality
          break;
        case "flac":
          options.push("-c:a flac", "-compression_level 12"); // slowest / most CPU
          break;
        case "opus":
          options.push("-c:a libopus", "-b:a 64k", "-vbr constrained", "-application audio"); // opus heavy mode
          break;
        case "wav":
          options.push("-c:a pcm_s24le"); // large PCM size, but trivial CPU
          break;
        default:
          options.push("-c:a libmp3lame", "-qscale:a 0"); // fallback = mp3 high quality
      }

      const command = ffmpeg(inputStream)
        .format(format)
        .outputOptions(options)
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          reject(err);
        })
        .on("start", cmd => console.log("FFmpeg started:", cmd));

      const outputStream = command.pipe({ end: true });
      resolve(outputStream);
    } catch (err) {
      console.error("Transcoding setup error:", err);
      reject(err);
    }
  });
}

module.exports = { transcodeBuffer };
