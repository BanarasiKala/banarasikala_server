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
const { config } = require("../config/env");
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

/**
 * How hard to encode, decided by what the clip is FOR.
 *
 * A reel fills a phone screen in the player and earns real bitrate. A muted decorative loop
 * sitting behind a heading does not — the Banaras Royale backdrop was shipping 15.6 MB to fill
 * a 352x418 box, which is most of a mobile visitor's first-page budget spent on wallpaper.
 */
const PROFILES = {
  feature: { height: 1920, qvbr: 7, maxBitrate: 2500000 },
  /**
   * 1080 rather than the 720 this started at.
   *
   * 720 was picked off the CSS box (352x418 for the Banaras Royale stage) without accounting
   * for device pixel ratio or for `object-fit: cover`. The clip is 9:16 cropped into a
   * 0.84-aspect box, so WIDTH is the binding constraint, not height: 406px of source stretched
   * across 1056 device px is a 2.6x upscale on a 3x phone. 1080 tall brings that to 1.74x.
   *
   * Not 1920: that would be pixel-exact but costs ~15 MB for a backdrop that sits behind a
   * scrim with a polaroid and a heading on top of it.
   */
  backdrop: { height: 1080, qvbr: 6, maxBitrate: 1500000 },
};
const TABLE_PROFILE = {
  banaras_royale: "backdrop",
  box_sections: "backdrop",
  occasions: "backdrop",
  products: "feature",
  reels: "feature",
};

/**
 * The reel bags on the home page are 79x97 CSS pixels and play three of these at once. Feeding
 * them the full master cost 39 MB before the visitor had scrolled a pixel.
 *
 * 480 tall covers a 79px tile even at 3x device pixels with room to spare, and the tile is
 * muted and aria-hidden so the variant carries no audio track at all. It is not trimmed:
 * MediaConvert's input clipping applies to the whole input, so shortening the preview would
 * shorten the master with it — not worth a second job to save a megabyte.
 */
const PREVIEW = { height: 480, qvbr: 4, maxBitrate: 300000 };

/**
 * The "Banaras in Motion" rail on the home page: 158x284 CSS, so 474x852 device pixels at 3x.
 * Feeding it the 1080x1920 master is a 2.25x oversample — about five times the pixels it can
 * show. 960 tall covers 852 with a little headroom.
 *
 * Deliberately separate from PREVIEW rather than one variant serving both: the bags need only
 * 297 device px, and making them download a 960-tall file would triple what every home-page
 * visitor pays for three tiles that are always on screen.
 */
const CARD = { height: 960, qvbr: 5, maxBitrate: 800000 };
const VARIANT_TABLES = new Set(["reels"]);

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

/**
 * Is this url something this pipeline produced?
 *
 * Named suffixes, matched on the TAIL rather than as a fixed list of whole names, so a
 * hand-rolled variant like `-v2-bg.mp4` is recognised without anyone remembering to extend a
 * list. This has now bitten twice: a re-encode written to `-bg.mp4` was swept back in and
 * re-encoded to `-bg-web.mp4`, and then `-bg1080.mp4` was swept into `-bg1080-web.mp4` by a
 * server whose deployed copy predated the fix.
 *
 * Two lessons are baked in here. First, the check has to survive a name nobody anticipated —
 * hence `-bg` matching any `*-bg.mp4`. Second, and more important: this is only the cheap
 * first pass. `findUnoptimised` also excludes every url recorded in video_jobs, and any one-off
 * script that writes a file MUST record it there, or that guard is blind to it by construction.
 */
const isOurOutput = (url) => /-(web|preview|card|poster|bg)\.mp4$/i.test(url)
  // -bg1080.mp4, -bg720.mp4: a height-tagged backdrop encode.
  || /-bg\d+\.mp4$/i.test(url);

/**
 * Every video url currently referenced by the app that is not already optimised, paired with
 * the table that referenced it — that is what picks the encode profile.
 *
 * First table wins if a url somehow appears in two: the file is encoded once, so a single
 * profile has to be chosen, and URL_COLUMNS order puts the more demanding surfaces last only
 * by coincidence. In practice an upload lands in exactly one table.
 */
const findUnoptimised = async () => {
  const found = new Map(); // url -> table

  /**
   * Everything this pipeline has ever produced, read back from the queue itself.
   *
   * The suffix test below is a first line of defence and it is not sufficient on its own: a
   * re-encode written to -bg.mp4 was swept straight back in and re-encoded to -bg-web.mp4
   * before that suffix was added to the pattern. Any new output name would repeat it. Asking
   * the table which urls are outputs cannot go stale that way — a file we made is a file we
   * recorded making.
   */
  const [produced] = await sequelize.query(
    `SELECT output_url AS u FROM "vns_saree"."video_jobs" WHERE output_url IS NOT NULL
     UNION
     SELECT preview_url AS u FROM "vns_saree"."video_jobs" WHERE preview_url IS NOT NULL
     UNION
     SELECT card_url AS u FROM "vns_saree"."video_jobs" WHERE card_url IS NOT NULL`,
  );
  const ours = new Set(produced.map((r) => r.u));

  for (const [table, col] of URL_COLUMNS) {
    const [rows] = await sequelize.query(
      `SELECT CAST("${col}" AS text) AS v FROM "vns_saree"."${table}"
       WHERE CAST("${col}" AS text) ILIKE '%.mp4%'`,
    );
    rows.forEach((r) => {
      // jsonb columns hold several urls in one value, so pull them all out.
      (String(r.v).match(/https?:\/\/[^"'\s,\\]+?\.mp4/gi) || []).forEach((u) => {
        // Anything this pipeline produced is already optimised — feeding an output back in
        // would encode it a second time and land on -web-web.mp4.
        if (isOurOutput(u) || ours.has(u)) return;
        if (!found.has(u)) found.set(u, table);
      });
    });
  }
  return [...found.entries()].map(([url, table]) => ({ url, table }));
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

/**
 * @param sourceUrl the original CDN url
 * @param sourceTable which table referenced it, which is what decides the encode profile and
 *   whether a tile-sized preview is worth producing. Unknown/missing falls back to `feature`,
 *   so a new caller that forgets to pass it gets quality rather than a silent downgrade.
 */
const submitJob = async (sourceUrl, sourceTable) => {
  const c = cfg();
  const { mc, s3 } = clients();
  const key = keyFromUrl(sourceUrl);
  if (!key) throw new Error("could not derive an S3 key from the url");

  const head = await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
  const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
  const base = key.slice(dir.length).replace(/\.mp4$/i, "");
  const profile = PROFILES[TABLE_PROFILE[sourceTable]] || PROFILES.feature;
  const wantsVariants = VARIANT_TABLES.has(sourceTable);

  /**
   * A silent, down-scaled copy for a surface that shows the clip small.
   *
   * No AudioDescriptions at all: every surface these feed is muted and aria-hidden, so an
   * audio track would be bytes nobody can ever hear.
   */
  const variantGroup = (name, suffix, spec) => ({
    Name: name,
    OutputGroupSettings: {
      Type: "FILE_GROUP_SETTINGS",
      FileGroupSettings: { Destination: `s3://${c.bucket}/${dir}${base}` },
    },
    Outputs: [{
      NameModifier: suffix,
      ContainerSettings: {
        Container: "MP4",
        Mp4Settings: { CslgAtom: "INCLUDE", FreeSpaceBox: "EXCLUDE", MoovPlacement: "PROGRESSIVE_DOWNLOAD" },
      },
      VideoDescription: {
        Height: spec.height,
        ScalingBehavior: "DEFAULT",
        CodecSettings: {
          Codec: "H_264",
          H264Settings: {
            RateControlMode: "QVBR",
            QvbrSettings: { QvbrQualityLevel: spec.qvbr },
            MaxBitrate: spec.maxBitrate,
            SceneChangeDetect: "TRANSITION_DETECTION",
          },
        },
      },
    }],
  });

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
            Height: profile.height,
            ScalingBehavior: "DEFAULT",
            CodecSettings: {
              Codec: "H_264",
              H264Settings: {
                // QVBR spends bitrate where the picture needs it, which suits fabric: flat
                // studio backdrops cost little and the zari detail keeps what it needs.
                RateControlMode: "QVBR",
                QvbrSettings: { QvbrQualityLevel: profile.qvbr },
                MaxBitrate: profile.maxBitrate,
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
      }, {
        /**
         * A poster frame, produced by the same job at no extra cost — MediaConvert bills per
         * minute of video output, not per still.
         *
         * It has to ride alongside the video output rather than being its own job: a job whose
         * only output is frame capture is rejected outright ("You must include at least one
         * output that has full video").
         *
         * Two captures at 1fps gives frames at roughly t=0s and t=1s. The t=1s frame is the one
         * used, because phone exports very often open on a black or half-exposed frame.
         */
        Name: "Thumbnail",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: { Destination: `s3://${c.bucket}/${dir}${base}` },
        },
        Outputs: [{
          NameModifier: "-poster",
          ContainerSettings: { Container: "RAW" },
          VideoDescription: {
            Width: 720,
            CodecSettings: {
              Codec: "FRAME_CAPTURE",
              FrameCaptureSettings: {
                FramerateNumerator: 1,
                FramerateDenominator: 1,
                MaxCaptures: 2,
                Quality: 80,
              },
            },
          },
        }],
      }, ...(wantsVariants ? [
        variantGroup("Preview", "-preview", PREVIEW),
        variantGroup("Card", "-card", CARD),
      ] : [])],
    },
  }));

  return {
    jobId: job.Job.Id,
    outputUrl: outputUrlFor(sourceUrl),
    previewUrl: wantsVariants ? sourceUrl.replace(/\.mp4$/i, "-preview.mp4") : null,
    cardUrl: wantsVariants ? sourceUrl.replace(/\.mp4$/i, "-card.mp4") : null,
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

/**
 * Settles which poster frame actually landed, stamps it cacheable, and writes it onto the
 * reel that owns it.
 *
 * Only reels get the url written back: occasions, box sections and Banaras Royale already
 * carry their own curated images, and a frame grabbed from the middle of a clip is a worse
 * poster than a photograph someone chose. Reels are the one place with nothing at all — the
 * storefront already reads `reel.thumbnail_url` into the <video poster> attribute and has
 * been quietly falling back to undefined for every row.
 */
const resolvePoster = async (row) => {
  const c = cfg();
  const { s3 } = clients();
  const base = row.source_url.replace(/\.mp4$/i, "");
  // Prefer the t=1s frame; fall back to t=0s if the clip was too short for a second capture.
  const candidates = [`${base}-poster.0000001.jpg`, `${base}-poster.0000000.jpg`];

  for (const url of candidates) {
    const key = keyFromUrl(url);
    try {
      await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
      await stampCacheControl(key);
      const [, meta] = await sequelize.query(
        `UPDATE "vns_saree"."reels" SET thumbnail_url = :poster
         WHERE video_url = :video AND (thumbnail_url IS NULL OR thumbnail_url = '')`,
        { replacements: { poster: url, video: row.output_url } },
      );
      if (meta.rowCount) console.log(`[VideoOptimize] poster set on ${meta.rowCount} reel(s)`);
      return url;
    } catch {
      // try the next candidate
    }
  }
  return null;
};

/**
 * Stamps a down-scaled variant cacheable and hands it to the reel that owns it.
 *
 * Kept separate from the master url: `reels.video_url` still points at the full-quality file,
 * which is what the full-screen player streams — and which measurement says is if anything
 * slightly UNDER-resolution for a 3x phone, so it must not be swapped for a variant. Only the
 * small surfaces read these columns, and each falls back to the master when its column is
 * empty, so a job that produced no variant degrades to the old behaviour rather than to a
 * blank tile.
 */
const publishVariant = async (row, column, url) => {
  if (!url) return null;
  const c = cfg();
  const { s3 } = clients();
  const key = keyFromUrl(url);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
    await stampCacheControl(key);
    const [, meta] = await sequelize.query(
      `UPDATE "vns_saree"."reels" SET "${column}" = :url WHERE video_url = :video`,
      { replacements: { url, video: row.output_url } },
    );
    if (meta.rowCount) console.log(`[VideoOptimize] ${column} set on ${meta.rowCount} reel(s)`);
    return url;
  } catch {
    return null;
  }
};

/** Queue anything referenced by the app that has not been optimised yet. */
const queueNewVideos = async () => {
  const items = await findUnoptimised();
  if (!items.length) return 0;
  const existing = await VideoJob.findAll({
    where: { source_url: items.map((i) => i.url) },
    attributes: ["source_url"],
  });
  const known = new Set(existing.map((r) => r.source_url));
  const fresh = items.filter((i) => !known.has(i.url));
  if (!fresh.length) return 0;
  await VideoJob.bulkCreate(
    fresh.map((i) => ({ source_url: i.url, source_table: i.table, status: "pending" })),
    { ignoreDuplicates: true },
  );
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
      const { jobId, outputUrl, previewUrl, cardUrl, sourceBytes } = await submitJob(row.source_url, row.source_table);
      await row.update({
        job_id: jobId,
        output_url: outputUrl,
        preview_url: previewUrl,
        card_url: cardUrl,
        source_bytes: sourceBytes,
        status: "processing",
        attempts: row.attempts + 1,
      });
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
        const poster = await resolvePoster(row);
        await publishVariant(row, "preview_url", row.preview_url);
        await publishVariant(row, "card_url", row.card_url);
        await row.update({ status: "complete", output_bytes: bytes || null, poster_url: poster || null });
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
 * May this process run the sweeper at all?
 *
 * Having the AWS keys is not enough of a test, because a developer's .env has them too and
 * points at the production database. That combination means every backend started on a laptop
 * becomes a second, invisible writer to live data — it re-encodes videos and repoints their
 * urls on a 60-second timer, using whatever code it happened to start with. A bare
 * `node server.js` has no file watcher, so it keeps that code even after the file is fixed.
 *
 * That is not hypothetical: a stale local process twice re-encoded already-optimised videos
 * and reverted corrections minutes after they were made, and the cause took a while to find
 * precisely because nothing about it was visible from the machine doing it.
 *
 * So the sweeper runs in production, or where someone has explicitly asked for it with
 * VIDEO_OPTIMIZE=1 — which is the right switch when deliberately testing the pipeline locally.
 */
const isEnabled = () => process.env.VIDEO_OPTIMIZE === "1" || config.nodeEnv === "production";

/**
 * Starts the background loop. Deliberately infrequent: uploads are occasional and a job takes
 * ~10s, so a minute of latency costs nothing and keeps both the API calls and the database
 * polling negligible.
 */
let timer = null;
const start = ({ intervalMs = 60000 } = {}) => {
  if (timer) return;
  if (!isEnabled()) {
    console.log(`[VideoOptimize] idle in ${config.nodeEnv} — set VIDEO_OPTIMIZE=1 to run it here`);
    return;
  }
  if (!isConfigured()) {
    console.log("[VideoOptimize] not configured — set MEDIACONVERT_ROLE_ARN/ENDPOINT to enable");
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
