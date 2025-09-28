import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
const ssm = new SSMClient({ region: "ap-southeast-2" });

const JAMENDO_BASE = "https://api.jamendo.com/v3.0";

async function getJamendoClientId() {
  const param = await ssm.send(new GetParameterCommand({
    Name: "/jamapp/JamendoClientID",
    WithDecryption: false
  }));
  return param.Parameter.Value;
}

// Search tracks
async function searchTracks(query) {
  const clientId = await getJamendoClientId();
  const url = `${JAMENDO_BASE}/tracks/?client_id=${clientId}&format=json&limit=10&search=${encodeURIComponent(query)}`;
  const res = await axios.get(url);
  return res.data.results;
}

// Get stream URL (direct link)
async function getStream(trackId) {
  const clientId = await getJamendoClientId();
  const url = `${JAMENDO_BASE}/tracks/file/?client_id=${clientId}&track_id=${trackId}`;
  const res = await axios.get(url);
  return res.data;
}

export { searchTracks, getStream };