// server/index.js
import fs from 'fs/promises';
import Memcached from 'memcached';
import path from 'path';

const memcachedAddress = 'jamapp-logo.km2jzi.cfg.apse2.cache.amazonaws.com:11211'; // replace with your endpoint

const memcached = new Memcached(memcachedAddress);

memcached.aSet = (key, value, ttlSeconds = 0) =>
  new Promise((resolve, reject) => memcached.set(key, value, ttlSeconds, err => (err ? reject(err) : resolve())));
memcached.aGet = key =>
  new Promise((resolve, reject) => memcached.get(key, (err, data) => (err ? reject(err) : resolve(data))));

async function cacheImage() {
  const filePath = path.resolve('./jam_PNG12-1738560013.png');                // point to your uploaded file
  const fileBuffer = await fs.readFile(filePath);            // returns a Buffer
  await memcached.aSet('jam_app', fileBuffer, 0);           // cache for 5 minutes
  console.log('Stored image as jam_app');

  const cached = await memcached.aGet('jam_app');
  if (!cached) throw new Error('jam_app not found in cache');
  await fs.writeFile('./jam-from-cache.png', cached);        // optional verification step
  console.log('Retrieved cached image and wrote jam-from-cache.png');
  memcached.end();
}

cacheImage().catch(err => {
  console.error(err);
  memcached.end();
});
