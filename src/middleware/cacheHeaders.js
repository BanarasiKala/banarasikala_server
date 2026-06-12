// Sets HTTP Cache-Control headers on public read endpoints.
// Browsers and CDNs will cache responses for the given duration.

const cacheFor = (seconds) => (req, res, next) => {
  if (req.method === "GET") {
    res.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=${seconds * 2}`);
  }
  next();
};

// 5 minutes — for taxonomy data (colors, materials, varieties, occasions)
const taxonomyCache = cacheFor(300);

// 2 minutes — for product catalog (changes more frequently)
const catalogCache = cacheFor(120);

// No cache — for authenticated or mutable data
const noCache = (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

module.exports = { taxonomyCache, catalogCache, noCache };
