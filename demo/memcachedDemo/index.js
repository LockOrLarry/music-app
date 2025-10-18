const Memcached = require("memcached");
const util = require("node:util");

// Replace this with the endpoint for your Elasticache instance
const memcachedAddress =
   "something.cfg.apse2.cache.amazonaws.com:11211";
const URL = "https://en.wikipedia.org/wiki/Memcached";

// For convenience using a global for the memcached server
var memcached = false;

function connectToMemcached() {
   memcached = new Memcached(memcachedAddress);
   memcached.on("failure", (details) => {
      console.log("Memcached server failure: ", details);
   });

   // Monkey patch some functions for convenience
   // We can call these with async
   memcached.aGet = util.promisify(memcached.get);
   memcached.aSet = util.promisify(memcached.set);
}

async function cachedFetch(URL) {
   // Check to see if the URL is in the cache
   const value = await memcached.aGet(URL);
   if (value) {
      return value;
   }
   console.log("Cache miss");

   // Cache doesn't have the value, so get it
   const response = await fetch(URL);
   const fetchedValue = await response.text();
   
   // Cache the data with TTL of 10 seconds
   await memcached.aSet(URL, fetchedValue, 10);
   return fetchedValue;
}

async function main() {
   connectToMemcached();

   // Let's see how long it takes to get from the external API
   console.time("not cached");
   await fetch(URL);
   console.timeEnd("not cached");

   // Now we'll do 10 cached fetches to see the time difference.
   for (i = 0; i < 10; i++) {
      console.time("cached");
      try {
         const data = await cachedFetch(URL);
      } catch (Err) {
         console.log(Err);
      }
      console.timeEnd("cached");
   }
}

main();
