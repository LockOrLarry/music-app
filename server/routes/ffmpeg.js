const ffmpeg = require("fluent-ffmpeg");
const { Readable } = require("stream");

/**
 * Transcode a track from a buffer or stream to the specified format with max CPU intensity.
 * @param {Buffer|Readable} input - The original audio data (Buffer or Stream).
 * @param {string} format - Target format (e.g., 'ogg', 'mp3', 'flac', 'wav', 'opus').
 * @returns {Promise<Readable>} - A readable stream of the transcoded track.
 */
function transcodeBuffer(input, format) {
  return new Promise((resolve, reject) => {
    try {
      // wrap Buffers in a Readable
      let inputStream = input;
      if (Buffer.isBuffer(input)) {
        const r = new Readable();
        r.push(input);
        r.push(null);
        inputStream = r;
      }

      // base options
      let options = ["-threads 0"];

      // choose codec-specific heavy settings
      switch (format) {
        case "mp3":
          options.push("-c:a libmp3lame", "-qscale:a 0");
          options.push("-af aresample=resampler=soxr"); // safe for mp3
          break;
        case "ogg":
          options.push("-c:a libvorbis", "-qscale:a 10");
          options.push("-af aresample=resampler=soxr"); // safe for vorbis
          break;
        case "flac":
          options.push("-c:a flac", "-compression_level 12");
          options.push("-af aresample=resampler=soxr:precision=33"); // CPU heavy, safe
          break;
        case "wav":
          options.push("-c:a pcm_s24le");
          options.push("-af aresample=resampler=soxr:precision=33"); // CPU heavy, safe
          break;
        case "opus":
          options.push("-c:a libopus", "-b:a 64k", "-vbr constrained", "-application audio");
          options.push("-af aresample=resampler=soxr"); // opus safe
          break;
        default:
          options.push("-c:a libmp3lame", "-qscale:a 0", "-af aresample=resampler=soxr");
      }

      const command = ffmpeg(inputStream)
        .format(format)
        .outputOptions(options)
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          reject(err);
        })

      const outputStream = command.pipe({ end: true });
      resolve(outputStream);
    } catch (err) {
      console.error("Transcoding setup error:", err);
      reject(err);
    }
  });
}

module.exports = { transcodeBuffer };
