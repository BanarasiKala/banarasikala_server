/**
 * Automatic video optimisation via AWS Elemental MediaConvert.
 *
 * Why a sweeper rather than a hook on each upload: video urls are written from five different
 * places (products.videos, reels.video_url, occasions.video, box_sections.videos,
 * banaras_royale.video) through several controllers. Hooking every one of them means a new
 * upload path added later silently skips optimisation. Sweeping the tables instead catches
 * everything by construction, including rows created by an admin script or a migration.
 *
 * Runs entirely on AWS, which is the point: the EC2 box is a free-tier micro with one shared
 * vCPU and 1 GB of RAM, so transcoding locally would burn CPU credits and throttle the site
 * for everyone. MediaConvert costs roughly a rupee per clip and uses none of the instance.
 *
 * Originals are never deleted here. The url is repointed and the source is left in the bucket,
 * so reverting a bad encode is a url swap rather than a restore.
 */
const { MediaConvertClient, CreateJobCommand, GetJobCommand } = require("@aws-sdk/client-mediaconvert");
const { S3Client, HeadObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { sequelize } = require("../config/db");
const VideoJob = require("../models/VideoJob");

const CACHE_CONTROL = "public, max-age=31536000, immutable";
// Every column in the schema that stores a video url, with the cast needed to write it back.
// REPLACE on the text cast works for varchar, text and jsonb alike, so one statement per
// column covers all three shapes.
const URL_COLUMNS = [
  ["banaras_royale", "video", "varchar"],
  ["box_sections", "videos", "jsonb"],
  ["occasions", "video", "varchar"],
  ["products", "videos", "jsonb"],
  ["reels", "video_url", "text"],
];

const MAX_ATTEMPTS = 3;
// A handful per sweep. MediaConvert bills per job and a runaway loop should cost pennies.
const SUBMIT_BATCH = 5;

const cfg = () => ({
  bucket: process.env.AWS_S3_BUCKET,
  region: process.env.AWS_REGION,
  role: process.env.MEDIACONVERT_ROLE_ARN,
  endpoint: process.env.MEDIACONVERT_ENDPOINT,
  creds: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const isConfigured = () => {
  const c = cfg();
  return Boolean(c.bucket && c.role && c.endpoint && c.creds.accessKeyId);
};

const clients = () => {
  const c = cfg();
  return {
    mc: new MediaConvertClient({ region: c.region, endpoint: c.endpoint, credentials: c.creds }),
    s3: new S3Client({ region: c.region, credentials: c.creds }),
  };
};

// CDN url -> S3 key. Everything after the host is the key.
const keyFromUrl = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
};

const outputUrlFor = (url) => url.replace(/\.mp4$/i, "-web.mp4");

/** Every video url currently referenced by the app that is not already optimised. */
const findUnoptimised = async () => {
  const found = new Set();
  for (const [table, col] of URL_COLUMNS) {
    const [rows] = await sequelize.query(
      `SELECT CAST("${col}" AS text) AS v FROM "vns_saree"."${table}"
       WHERE CAST("${col}" AS text) ILIKE '%.mp4%'`,
    );
    rows.forEach((r) => {
      // jsonb columns hold several urls in one value, so pull them all out.
      (String(r.v).match(/https?:\/\/[^"'\s,\\]+?\.mp4/gi) || []).forEach((u) => {
        if (!/-web\.mp4$/i.test(u)) found.add(u);
      });
    });
  }
  return [...found];
};

/** Point every reference at the optimised file. */
const repointUrl = async (oldUrl, newUrl) => {
  let rows = 0;
  for (const [table, col, cast] of URL_COLUMNS) {
    const [, meta] = await sequelize.query(
      `UPDATE "vns_saree"."${table}"
       SET "${col}" = REPLACE(CAST("${col}" AS text), :oldUrl, :newUrl)::${cast}
       WHERE CAST("${col}" AS text) LIKE :like`,
      { replacements: { oldUrl, newUrl, like: `%${oldUrl}%` } },
    );
    rows += meta.rowCount || 0;
  }
  return rows;
};

const submitJob = async (sourceUrl) => {
  const c = cfg();
  const { mc, s3 } = clients();
  const key = keyFromUrl(sourceUrl);
  if (!key) throw new Error("could not derive an S3 key from the url");

  const head = await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
  const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
  const base = key.slice(dir.length).replace(/\.mp4$/i, "");

  const job = await mc.send(new CreateJobCommand({
    Role: c.role,
    Settings: {
      TimecodeConfig: { Source: "ZEROBASED" },
      Inputs: [{
        FileInput: `s3://${c.bucket}/${key}`,
        AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
        VideoSelector: {},
        TimecodeSource: "ZEROBASED",
      }],
      OutputGroups: [{
        Name: "File Group",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: { Destination: `s3://${c.bucket}/${dir}${base}` },
        },
        Outputs: [{
          NameModifier: "-web",
          ContainerSettings: {
            Container: "MP4",
            // PROGRESSIVE_DOWNLOAD puts the index at the front so playback can start
            // before the file has finished arriving — the equivalent of ffmpeg's +faststart.
            Mp4Settings: { CslgAtom: "INCLUDE", FreeSpaceBox: "EXCLUDE", MoovPlacement: "PROGRESSIVE_DOWNLOAD" },
          },
          VideoDescription: {
            Height: 1920,
            ScalingBehavior: "DEFAULT",
            CodecSettings: {
              Codec: "H_264",
              H264Settings: {
                // QVBR spends bitrate where the picture needs it, which suits fabric: flat
                // studio backdrops cost little and the zari detail keeps what it needs.
                RateControlMode: "QVBR",
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: 2500000,
                SceneChangeDetect: "TRANSITION_DETECTION",
              },
            },
          },
          AudioDescriptions: [{
            CodecSettings: {
              Codec: "AAC",
              AacSettings: { Bitrate: 96000, CodingMode: "CODING_MODE_2_0", SampleRate: 48000 },
            },
          }],
        }],
      }],
    },
  }));

  return {
    jobId: job.Job.Id,
    outputUrl: outputUrlFor(sourceUrl),
    sourceBytes: head.ContentLength || null,
  };
};

/**
 * MediaConvert writes its output without a Cache-Control header, whatever the source had —
 * so it has to be stamped on afterwards or every optimised file lands uncacheable and the
 * whole exercise is undone. Copy-onto-self with REPLACE is the only way to set it.
 */
const stampCacheControl = async (key) => {
  const c = cfg();
  const { s3 } = clients();
  const head = await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
  if (head.CacheControl === CACHE_CONTROL) return head.ContentLength;
  await s3.send(new CopyObjectCommand({
    Bucket: c.bucket,
    Key: key,
    CopySource: encodeURIComponent(`${c.bucket}/${key}`),
    MetadataDirective: "REPLACE",
    CacheControl: CACHE_CONTROL,
    ContentType: head.ContentType || "video/mp4",
    Metadata: head.Metadata || {},
  }));
  return head.ContentLength;
};

/** Queue anything referenced by the app that has not been optimised yet. */
const queueNewVideos = async () => {
  const urls = await findUnoptimised();
  if (!urls.length) return 0;
  const existing = await VideoJob.findAll({ where: { source_url: urls }, attributes: ["source_url"] });
  const known = new Set(existing.map((r) => r.source_url));
  const fresh = urls.filter((u) => !known.has(u));
  if (!fresh.length) return 0;
  await VideoJob.bulkCreate(fresh.map((source_url) => ({ source_url, status: "pending" })), { ignoreDuplicates: true });
  console.log(`[VideoOptimize] queued ${fresh.length} new video(s)`);
  return fresh.length;
};

const submitPending = async () => {
  const pending = await VideoJob.findAll({
    where: { status: "pending" },
    order: [["id", "ASC"]],
    limit: SUBMIT_BATCH,
  });
  for (const row of pending) {
    try {
      const { jobId, outputUrl, sourceBytes } = await submitJob(row.source_url);
      await row.update({ job_id: jobId, output_url: outputUrl, source_bytes: sourceBytes, status: "processing", attempts: row.attempts + 1 });
      console.log(`[VideoOptimize] submitted ${jobId} for ${row.source_url.split("/").pop()}`);
    } catch (e) {
      const attempts = row.attempts + 1;
      await row.update({
        attempts,
        status: attempts >= MAX_ATTEMPTS ? "error" : "pending",
        error_message: e.message,
      });
      console.error(`[VideoOptimize] submit failed (${attempts}/${MAX_ATTEMPTS}): ${e.message}`);
    }
  }
};

const pollProcessing = async () => {
  const { mc } = clients();
  const rows = await VideoJob.findAll({ where: { status: "processing" }, limit: 20 });
  for (const row of rows) {
    try {
      const { Job } = await mc.send(new GetJobCommand({ Id: row.job_id }));
      if (Job.Status === "COMPLETE") {
        const outKey = keyFromUrl(row.output_url);
        const bytes = await stampCacheControl(outKey);
        const changed = await repointUrl(row.source_url, row.output_url);
        await row.update({ status: "complete", output_bytes: bytes || null });
        const saved = row.source_bytes && bytes
          ? ` (${(100 - (Number(bytes) / Number(row.source_bytes)) * 100).toFixed(0)}% smaller)`
          : "";
        console.log(`[VideoOptimize] done ${row.output_url.split("/").pop()} — ${changed} row(s) repointed${saved}`);
      } else if (Job.Status === "ERROR" || Job.Status === "CANCELED") {
        await row.update({ status: "error", error_message: Job.ErrorMessage || Job.Status });
        console.error(`[VideoOptimize] job ${row.job_id} ${Job.Status}: ${Job.ErrorMessage || ""}`);
      }
    } catch (e) {
      console.error(`[VideoOptimize] poll failed for ${row.job_id}: ${e.message}`);
    }
  }
};

const sweep = async () => {
  if (!isConfigured()) return;
  try {
    await queueNewVideos();
    await submitPending();
    await pollProcessing();
  } catch (e) {
    console.error("[VideoOptimize] sweep error:", e.message);
  }
};

/**
 * Starts the background loop. Deliberately infrequent: uploads are occasional and a job takes
 * ~10s, so a minute of latency costs nothing and keeps both the API calls and the database
 * polling negligible.
 */
let timer = null;
const start = ({ intervalMs = 60000 } = {}) => {
  if (timer || !isConfigured()) {
    if (!isConfigured()) console.log("[VideoOptimize] not configured — set MEDIACONVERT_ROLE_ARN/ENDPOINT to enable");
    return;
  }
  console.log("[VideoOptimize] watching for unoptimised videos");
  sweep();
  timer = setInterval(sweep, intervalMs);
  if (timer.unref) timer.unref();
};

module.exports = {
  start,
  sweep,
  queueNewVideos,
  submitPending,
  pollProcessing,
  findUnoptimised,
  repointUrl,
  isConfigured,
  // Exported so a single file can be re-run by hand — useful when one job fails and the
  // whole sweep should not be repeated to retry it.
  submitJob,
  stampCacheControl,
};
