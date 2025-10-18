const fs = require('fs/promises');
const Memcached = require('memcached');
const path = require('path');

const memcachedAddress = 'jamapp-logo.km2jzi.cfg.apse2.cache.amazonaws.com:11211'; // replace with your endpoint

const memcached = new Memcached(memcachedAddress);

memcached.aSet = (key, value, ttlSeconds = 0) =>
  new Promise((resolve, reject) => memcached.set(key, value, ttlSeconds, err => (err ? reject(err) : resolve())));
memcached.aGet = key =>
  new Promise((resolve, reject) => memcached.get(key, (err, data) => (err ? reject(err) : resolve(data))));

async function cacheImage() {
  const filePath = path.resolve('./jam_PNG12-1738560013.png');                // point to your uploaded file
  const fileBuffer = await fs.readFile(filePath);            // returns a Buffer
  await memcached.aSet('jam_png', fileBuffer, 0);           // cache for 5 minutes
  console.log('Stored image as jam_png');

  const cached = await memcached.aGet('jam_png');
  if (!cached) throw new Error('jam_app not found in cache');
  memcached.end();
}

cacheImage().catch(err => {
  console.error(err);
  memcached.end();
});
