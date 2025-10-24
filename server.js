require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const SUFFIXES = ["", "2", "3"];

function env(name, suffix = "") {
  return process.env[`${name}${suffix}`] || "";
}

function normalizePublicUrl(raw) {
  if (!raw) return "";
  let u = String(raw).trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
  u = u.replace(/^https::+/i, "https:").replace(/^http::+/i, "http:");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  u = u.replace(/^([^:\/?#]+):\/+/i, (m, p1) => p1.toLowerCase() + "://");
  return u.replace(/\/+$/g, "");
}

// joinUrl that encodes path segments safely (so slashes in keys are preserved)
function joinUrl(base, path) {
  if (!base) return path ? `/${encodeURIComponent(path)}` : "";
  const b = String(base).replace(/\/+$/g, "");
  const pRaw = String(path || "").replace(/^\/+/g, "");
  if (!pRaw) return b;
  const segments = pRaw.split('/').map(s => encodeURIComponent(s));
  return `${b}/${segments.join('/')}`;
}

function makeConfigs() {
  const cfgs = [];
  for (const s of SUFFIXES) {
    const bucket = env("R2_BUCKET", s);
    const endpoint = env("R2_ENDPOINT", s);
    const accessId = env("R2_ACCESS_KEY_ID", s);
    const secret = env("R2_SECRET_ACCESS_KEY", s);
    const region = env("R2_REGION", s) || "auto";
    const publicUrl = normalizePublicUrl(env("R2_PUBLIC_URL", s));
    const frontendOrigin = env("FRONTEND_ORIGIN", s) || "*";
    const account = env("CF_ACCOUNT_ID", s) || "";

    if (bucket && endpoint && accessId && secret) {
      const client = new S3Client({
        region,
        endpoint,
        credentials: {
          accessKeyId: accessId,
          secretAccessKey: secret,
        },
        forcePathStyle: true, // helps with some S3-compatible endpoints
      });

      cfgs.push({
        id: s || "1",
        bucket,
        endpoint,
        publicUrl,
        client,
        frontendOrigin,
        account,
      });
    }
  }
  return cfgs;
}

const configs = makeConfigs();
if (!configs.length) {
  console.warn('⚠️  Warning: no R2/S3 configs detected. Set env vars like R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
}

// serve static public (if you have a frontend build folder)
app.use(express.static('public'));

// health and root
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/', (req, res) => {
  res.send('Hello — server is up. Use /files or /files/:setId');
});

// list objects helper (returns array or array with single error-object)
async function listFilesForConfig(cfg, maxKeys = 1000) {
  try {
    const data = await cfg.client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: maxKeys }));
    const contents = data.Contents || [];
    return contents.map((f) => {
      const key = String(f.Key);
      const url = cfg.publicUrl ? joinUrl(cfg.publicUrl, key) : `/${encodeURIComponent(key)}`;
      return {
        set: cfg.id,
        account: cfg.account || null,
        bucket: cfg.bucket,
        name: key,
        size: f.Size || 0,
        lastModified: f.LastModified || null,
        url,
      };
    });
  } catch (err) {
    console.error(`Error listing bucket ${cfg.bucket} (set ${cfg.id}):`, err && err.message ? err.message : String(err));
    return [{ set: cfg.id, bucket: cfg.bucket, error: String(err && err.message ? err.message : err) }];
  }
}

app.get('/files', async (req, res) => {
  try {
    const lists = await Promise.all(configs.map((c) => listFilesForConfig(c)));
    const flat = lists.flat().filter(Boolean);

    const normalFiles = flat.filter((f) => !f.error && f.name);
    normalFiles.sort((a, b) => {
      const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return tb - ta || a.name.localeCompare(b.name);
    });

    const errorEntries = flat.filter((f) => f.error);
    res.json([...errorEntries, ...normalFiles]);
  } catch (err) {
    console.error('GET /files failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/files/:setId', async (req, res) => {
  try {
    const setId = req.params.setId;
    const cfg = configs.find((c) => c.id === setId || (setId === "1" && c.id === "1"));
    if (!cfg) return res.status(404).json({ ok: false, error: "set not found" });
    const list = await listFilesForConfig(cfg);
    if (Array.isArray(list) && list.length === 1 && list[0].error) {
      return res.status(500).json({ ok: false, set: cfg.id, error: list[0].error });
    }
    list.sort((a, b) => {
      const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return tb - ta || a.name.localeCompare(b.name);
    });
    res.json({ ok: true, set: cfg.id, files: list });
  } catch (err) {
    console.error('GET /files/:setId failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// create http server and handle timeouts
const server = http.createServer(app);
server.setTimeout(120000); // 2 minutes

// global error handlers to avoid silent crash loops
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('unhandledRejection at:', p, 'reason:', reason);
});

// graceful shutdown
async function shutdown(sig) {
  console.info(`Received ${sig}. Shutting down gracefully...`);
  server.close(() => {
    console.info('Closed http server.');
    process.exit(0);
  });
  // force exit after 10s
  setTimeout(() => {
    console.error('Could not close connections in time, forcing shut down');
    process.exit(1);
  }, 10000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`Server ready: http://localhost:${PORT}  (host bound ${HOST})`);
});
