const fs = require("fs");
const path = require("path");

/**
 * Images for the invoice, as data URIs.
 *
 * They have to be inlined rather than linked. The invoice is handed to the browser as one
 * HTML string and rendered from a blob URL, so a relative path has no server to resolve
 * against; and the storefront's own copies are fingerprinted at build time, so their URLs
 * are not knowable from here. A data URI also survives the customer saving the page or
 * printing it to PDF offline, which a linked image does not.
 *
 * Read once and cached: an invoice is generated per request and re-reading a few hundred
 * kilobytes off disk each time would be pure waste.
 *
 * A missing file returns "" rather than throwing. The signature in particular is optional
 * — the invoice must still render for a shop that has not supplied one — and every caller
 * treats "" as "draw nothing here".
 */
const ASSET_DIR = path.join(__dirname, "..", "assets");

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const cache = new Map();

/**
 * Reads one asset. Silent on a miss — whether a missing file is worth mentioning depends
 * on what was being looked for, so the decision is left to the callers below. A probe
 * across four candidate extensions must not log four warnings for one absent signature.
 *
 * @param {string} fileName  A file inside src/assets, e.g. "invoice-logo.png".
 * @returns {string} A `data:` URI, or "" when the file is absent or unreadable.
 */
const dataUri = (fileName) => {
  if (cache.has(fileName)) return cache.get(fileName);

  let uri = "";
  try {
    const filePath = path.join(ASSET_DIR, fileName);
    const mime = MIME_BY_EXT[path.extname(fileName).toLowerCase()];
    if (mime) {
      uri = `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
    }
  } catch {
    uri = "";
  }

  cache.set(fileName, uri);
  return uri;
};

/**
 * Whichever of these exists is used, in order. A signature is a scan or an export and
 * arrives in whatever format the shop happened to save it in, so the usual ones are all
 * accepted rather than forcing a conversion.
 */
const firstAvailable = (fileNames) => {
  for (const name of fileNames) {
    const uri = dataUri(name);
    if (uri) return uri;
  }
  return "";
};

// Warned about once per process, not per invoice: the cache means the lookup only
// actually happens on the first render, and a line per download would be noise.
const warned = new Set();
const warnOnce = (key, message) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[invoiceAssets] ${message}`);
};

const invoiceLogo = () => {
  const uri = dataUri("invoice-logo.png");
  // Worth saying: the logo is committed, so its absence means something went wrong.
  if (!uri) warnOnce("logo", "src/assets/invoice-logo.png is missing — invoices will print the name in type instead.");
  return uri;
};

// `sign.*` is listed too, and first, because that is the name the signature was actually
// committed under. The invoice-signature.* names came first and are kept so an existing
// deployment that used one keeps working — but a file sitting in src/assets called sign.jpeg is
// unmistakably the signature, and silently ignoring it (which is what happened) is worse than
// accepting either name.
const SIGNATURE_CANDIDATES = [
  "sign.png",
  "sign.jpg",
  "sign.jpeg",
  "sign.webp",
  "invoice-signature.png",
  "invoice-signature.jpg",
  "invoice-signature.jpeg",
  "invoice-signature.webp",
];

const invoiceSignature = () => {
  const uri = firstAvailable(SIGNATURE_CANDIDATES);
  // Not an error: a shop that has not supplied one gets the "Auth / Sign" circle.
  if (!uri) warnOnce("signature", "no src/assets/sign.* or invoice-signature.* found — invoices will print the Auth / Sign circle.");
  return uri;
};

module.exports = { dataUri, invoiceLogo, invoiceSignature };
