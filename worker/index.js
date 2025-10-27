const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { JOB_STATUSES, updateJobRecord } = require("../shared/downloadJobs");
const { transcodeBuffer } = require("../shared/ffmpeg");
require("dotenv").config();

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const QUEUE_URL = process.env.DOWNLOAD_JOBS_QUEUE_URL;
const JOBS_TABLE = process.env.DOWNLOAD_JOBS_TABLE_NAME;
const RESULTS_BUCKET = process.env.DOWNLOAD_RESULTS_BUCKET;
const RAW_PREFIX = process.env.DOWNLOAD_RESULTS_PREFIX || "downloads/";
const NORMALIZED_PREFIX = RAW_PREFIX.endsWith("/") ? RAW_PREFIX : `${RAW_PREFIX}/`;
const VISIBILITY_TIMEOUT = parseInt(process.env.DOWNLOAD_WORKER_VISIBILITY_TIMEOUT || "180", 10);
const WAIT_TIME_SECONDS = parseInt(process.env.DOWNLOAD_WORKER_WAIT_TIME_SECONDS || "20", 10);

const sqs = new SQSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

let jamendoClientId;

function ensureConfigured() {
  const missing = [];
  if (!QUEUE_URL) missing.push("DOWNLOAD_JOBS_QUEUE_URL");
  if (!JOBS_TABLE) missing.push("DOWNLOAD_JOBS_TABLE_NAME");
  if (!RESULTS_BUCKET) missing.push("DOWNLOAD_RESULTS_BUCKET");
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function ensureJamendoClientId() {
  if (jamendoClientId) return jamendoClientId;
  const param = await ssm.send(new GetParameterCommand({
    Name: "/jamapp/JamendoClientID",
    WithDecryption: false
  }));
  jamendoClientId = param.Parameter.Value;
  return jamendoClientId;
}

async function fetchTrack(trackId) {
  const clientId = await ensureJamendoClientId();
  const url = `https://api.jamendo.com/v3.0/tracks/?id=${trackId}&client_id=${clientId}&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch track metadata: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.results || !data.results.length) {
    throw new Error(`Track ${trackId} not found on Jamendo`);
  }
  return data.results[0];
}

async function downloadOriginalAudio(audioUrl) {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Audio download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

async function uploadToS3(key, body, contentType, metadata, downloadName) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: RESULTS_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
      ...(downloadName ? { ContentDisposition: `attachment; filename="${downloadName}"` } : {})
    }
  });
  await upload.done();
}

function buildDownloadFileName(track, trackId, format) {
  const rawName = track?.name || `track_${trackId}`;
  const safeStem = rawName
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "_") || `track_${trackId}`;
  return `${safeStem}.${format}`;
}

async function processJobMessage(message) {
  const now = () => new Date().toISOString();
  let payload;
  try {
    payload = JSON.parse(message.Body || "{}");
  } catch (err) {
    console.error("Failed to parse job payload, discarding message", err);
    return true;
  }

  const { jobId, userId, trackId, format } = payload || {};
  if (!jobId || !userId || !trackId || !format) {
    console.error("Job payload missing required fields", payload);
    return true;
  }

  try {
    await updateJobRecord(dynamo, JOBS_TABLE, jobId, {
      status: JOB_STATUSES.RUNNING,
      updatedAt: now()
    });
  } catch (err) {
    console.error(`Failed to mark job ${jobId} as RUNNING`, err);
  }

  try {
    const track = await fetchTrack(trackId);
    const audioUrl = track.audio;
    if (!audioUrl) {
      throw new Error("Track metadata missing audio URL");
    }

    const urlParams = new URLSearchParams(new URL(audioUrl).search);
    const sourceFormat = urlParams.get("format")?.startsWith("mp3") ? "mp3" : urlParams.get("format");
    const originalBuffer = await downloadOriginalAudio(audioUrl);

    let body = originalBuffer;
    let contentType = `audio/${format}`;
    if (!sourceFormat || sourceFormat !== format) {
      body = await transcodeBuffer(originalBuffer, format);
    } else {
      contentType = `audio/${sourceFormat}`;
    }

    const key = `${NORMALIZED_PREFIX}${jobId}.${format}`;
    const downloadName = buildDownloadFileName(track, trackId, format);

    await uploadToS3(key, body, contentType, {
      trackid: String(trackId),
      requestedformat: format,
      sourceformat: sourceFormat || "unknown"
    }, downloadName);

    await updateJobRecord(dynamo, JOBS_TABLE, jobId, {
      status: JOB_STATUSES.COMPLETED,
      updatedAt: now(),
      resultKey: key,
      sourceFormat: sourceFormat || format
    });

    return true;
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err);
    try {
      await updateJobRecord(dynamo, JOBS_TABLE, jobId, {
        status: JOB_STATUSES.FAILED,
        updatedAt: now(),
        message: err.message
      });
    } catch (updateErr) {
      console.error(`Failed to mark job ${jobId} as FAILED`, updateErr);
    }
    return true;
  }
}

async function pollQueue() {
  ensureConfigured();

  console.log("Worker started, polling queue:", QUEUE_URL);
  for (;;) {
    try {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        VisibilityTimeout: VISIBILITY_TIMEOUT
      }));

      const messages = response.Messages || [];
      if (!messages.length) {
        continue;
      }

      for (const message of messages) {
        const handled = await processJobMessage(message);
        if (handled) {
          try {
            await sqs.send(new DeleteMessageCommand({
              QueueUrl: QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle
            }));
          } catch (deleteErr) {
            console.error("Failed to delete message", deleteErr);
          }
        }
      }
    } catch (err) {
      console.error("Queue poll error:", err);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

process.on("SIGINT", () => {
  console.log("Worker shutting down (SIGINT)");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Worker shutting down (SIGTERM)");
  process.exit(0);
});

pollQueue().catch(err => {
  console.error("Worker terminated due to startup error:", err);
  process.exit(1);
});
