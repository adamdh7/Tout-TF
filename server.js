require('dotenv').config();
const express = require('express');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;
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

function joinUrl(base, path) {
  if (!base) return path ? `/${encodeURIComponent(path)}` : "";
  const b = String(base).replace(/\/+$/g, "");
  const p = String(path || "").replace(/^\/+/g, "");
  return p ? `${b}/${encodeURIComponent(p)}` : b;
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
    const account = env("CF_ACCOUNT_ID", s) || env("CF_ACCOUNT_ID" + s, s);

    if (bucket && endpoint && accessId && secret) {
      const client = new S3Client({
        region,
        endpoint,
        credentials: {
          accessKeyId: accessId,
          secretAccessKey: secret,
        },
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

app.use(express.static('public'));

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
    return [{ set: cfg.id, bucket: cfg.bucket, error: String(err) }];
  }
}

app.get('/files', async (req, res) => {
  try {
    const lists = await Promise.all(configs.map((c) => listFilesForConfig(c)));
    const flat = lists.flat().filter(Boolean);

    // if any element is an error-object (contains error), keep them as-is.
    // Otherwise sort by lastModified desc
    const normalFiles = flat.filter((f) => !f.error && f.name);
    normalFiles.sort((a, b) => {
      const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return tb - ta || a.name.localeCompare(b.name);
    });

    // combine error entries and sorted normal files, preserve set id grouping if present
    const errorEntries = flat.filter((f) => f.error);
    res.json([...errorEntries, ...normalFiles]);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/files/:setId', async (req, res) => {
  try {
    const setId = req.params.setId;
    const cfg = configs.find((c) => c.id === setId || (setId === "1" && c.id === "1"));
    if (!cfg) return res.status(404).json({ ok: false, error: "set not found" });
    const list = await listFilesForConfig(cfg);
    // if first element is error object, return it
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
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server ready: http://localhost:${PORT}`);
});
