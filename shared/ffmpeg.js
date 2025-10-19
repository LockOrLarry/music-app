const ffmpeg = require("fluent-ffmpeg");
const { Readable } = require("stream");

function transcodeBuffer(input, format) {
  return new Promise((resolve, reject) => {
    try {
      let inputStream = input;
      if (Buffer.isBuffer(input)) {
        const r = new Readable();
        r.push(input);
        r.push(null);
        inputStream = r;
      }

      const options = ["-threads 0"];
      switch (format) {
        case "mp3":
          options.push("-c:a libmp3lame", "-qscale:a 0");
          options.push("-af aresample=resampler=soxr");
          break;
        case "ogg":
          options.push("-c:a libvorbis", "-qscale:a 10");
          options.push("-af aresample=resampler=soxr");
          break;
        case "flac":
          options.push("-c:a flac", "-compression_level 12");
          options.push("-af aresample=resampler=soxr:precision=33");
          break;
        case "wav":
          options.push("-c:a pcm_s24le");
          options.push("-af aresample=resampler=soxr:precision=33");
          break;
        case "opus":
          options.push("-c:a libopus", "-b:a 64k", "-vbr constrained", "-application audio");
          options.push("-af aresample=resampler=soxr");
          break;
        default:
          options.push("-c:a libmp3lame", "-qscale:a 0", "-af aresample=resampler=soxr");
      }

      const command = ffmpeg(inputStream)
        .format(format)
        .outputOptions(options)
        .on("error", err => {
          console.error("FFmpeg error:", err);
          reject(err);
        });

      const outputStream = command.pipe({ end: true });
      resolve(outputStream);
    } catch (err) {
      console.error("Transcoding setup error:", err);
      reject(err);
    }
  });
}

module.exports = { transcodeBuffer };
