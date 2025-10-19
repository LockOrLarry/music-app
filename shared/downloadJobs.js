const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");

const JOB_STATUSES = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED"
};

function toDynamoItem(job) {
  const item = {
    job_id: job.jobId,
    user_id: job.userId,
    track_id: job.trackId,
    requested_format: job.format,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt
  };

  if (job.message) item.message = job.message;
  if (job.resultKey) item.result_key = job.resultKey;
  if (job.source_format) item.source_format = job.sourceFormat;

  return marshall(item, { removeUndefinedValues: true });
}

async function createJobRecord(dynamo, tableName, job) {
  const { PutItemCommand } = require("@aws-sdk/client-dynamodb");
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: toDynamoItem(job),
      ConditionExpression: "attribute_not_exists(job_id)"
    })
  );
}

async function updateJobRecord(dynamo, tableName, jobId, updates) {
  const { UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
  const ExpressionAttributeNames = {
    "#status": "status",
    "#updated_at": "updated_at"
  };
  const ExpressionAttributeValues = {
    ":status": { S: updates.status },
    ":updated_at": { S: updates.updatedAt }
  };
  let UpdateExpression = "SET #status = :status, #updated_at = :updated_at";

  if (updates.message !== undefined) {
    ExpressionAttributeNames["#message"] = "message";
    ExpressionAttributeValues[":message"] = { S: updates.message };
    UpdateExpression += ", #message = :message";
  }

  if (updates.resultKey !== undefined) {
    ExpressionAttributeNames["#result_key"] = "result_key";
    ExpressionAttributeValues[":result_key"] = { S: updates.resultKey };
    UpdateExpression += ", #result_key = :result_key";
  }

  if (updates.sourceFormat !== undefined) {
    ExpressionAttributeNames["#source_format"] = "source_format";
    ExpressionAttributeValues[":source_format"] = { S: updates.sourceFormat };
    UpdateExpression += ", #source_format = :source_format";
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        job_id: { S: jobId }
      },
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues
    })
  );
}

async function getJobRecord(dynamo, tableName, jobId) {
  const { GetItemCommand } = require("@aws-sdk/client-dynamodb");
  const response = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { job_id: { S: jobId } }
    })
  );
  if (!response.Item) return null;
  const data = unmarshall(response.Item);
  return {
    jobId: data.job_id,
    userId: data.user_id,
    trackId: data.track_id,
    format: data.requested_format,
    status: data.status,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    message: data.message,
    resultKey: data.result_key,
    sourceFormat: data.source_format
  };
}

module.exports = {
  JOB_STATUSES,
  createJobRecord,
  updateJobRecord,
  getJobRecord
};
