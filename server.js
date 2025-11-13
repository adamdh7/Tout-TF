// server.js
require('dotenv').config();
const express = require('express');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

/* --------------------------
   Helpers: URL normalization
   -------------------------- */

function normalizePublicUrl(raw) {
  if (!raw) return '';
  let u = String(raw).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/^(https?:)\/+/i, (m, p1) => p1 + '//');
  u = u.replace(/\/+$/g, '');
  return u;
}

/**
 * joinUrl(base, path)
 * - preserve slashes between path segments
 * - encode each segment so "/" are preserved
 */
function joinUrl(base, path) {
  if (!base) return path ? `${encodeURIComponent(path)}` : '';
  const b = String(base).replace(/\/+$/g, '');
  const p = String(path || '').replace(/^\/+/g, '');
  if (!p) return b;
  const encoded = p.split('/').map(seg => encodeURIComponent(seg)).join('/');
  return `${b}/${encoded}`;
}

function buildPublicUrl(cfg, key) {
  // prefer PUBLIC_URL if present, else endpoint, else fallback to key-only
  if (cfg.publicUrl) return joinUrl(cfg.publicUrl, key);
  if (cfg.endpoint) {
    // ensure endpoint has protocol
    let ep = String(cfg.endpoint).trim();
    if (!/^https?:\/\//i.test(ep)) ep = 'https://' + ep.replace(/^\/+/g, '');
    ep = ep.replace(/\/+$/g, '');
    return joinUrl(ep, key);
  }
  return encodeURI(key);
}

/* --------------------------
   Load configs from env
   -------------------------- */

function makeConfigsFromEnv() {
  const wantedProps = [
    'BUCKET', 'ENDPOINT', 'ACCESS_KEY_ID', 'ACCESS_KEY', 'SECRET_ACCESS_KEY', 'SECRET',
    'PUBLIC_URL', 'REGION', 'FRONTEND_ORIGIN', 'CF_ACCOUNT_ID',
  ];
  const groups = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.trim();
    let m = key.match(/^([A-Z0-9]+?)_([A-Z0-9_]+?)(?:_([0-9]+))?$/i);
    if (m) {
      const prefix = m[1];
      const prop = m[2];
      const suffix = m[3] || '';
      const up = prop.toUpperCase();
      if (wantedProps.some(w => up === w || up === w.replace(/_/g, ''))) {
        const groupKey = `${prefix}${suffix ? '_' + suffix : ''}`;
        groups[groupKey] = groups[groupKey] || { prefix, suffix, raw: {} };
        groups[groupKey].raw[up] = v;
        continue;
      }
    }
    m = key.match(/^([A-Z0-9]+?)_([0-9]+)_([A-Z0-9_]+)$/i);
    if (m) {
      const prefix = m[1];
      const suffix = m[2] || '';
      const prop = m[3];
      const up = prop.toUpperCase();
      if (wantedProps.some(w => up === w || up === w.replace(/_/g, ''))) {
        const groupKey = `${prefix}${suffix ? '_' + suffix : ''}`;
        groups[groupKey] = groups[groupKey] || { prefix, suffix, raw: {} };
        groups[groupKey].raw[up] = v;
        continue;
      }
    }
  }

  const configs = [];
  for (const [groupKey, info] of Object.entries(groups)) {
    const r = info.raw;
    const accessKey = r.ACCESS_KEY_ID || r.ACCESS_KEY || r['ACCESSKEY'] || r['ACCESSKEYID'];
    const secretKey = r.SECRET_ACCESS_KEY || r.SECRET || r['SECRETKEY'];
    const bucket = r.BUCKET || r.BUCKET_NAME || r['BUCKETNAME'];
    const endpoint = r.ENDPOINT;
    const region = r.REGION || 'auto';
    const publicUrl = normalizePublicUrl(r.PUBLIC_URL || r.PUBLICURL || r.PUBLIC);
    const frontendOrigin = r.FRONTEND_ORIGIN || r.FRONTENDORIGIN || '*';
    const account = r.CF_ACCOUNT_ID || r.CFACCOUNTID || null;

    if (bucket && endpoint && accessKey && secretKey) {
      const client = new S3Client({
        region,
        endpoint,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        forcePathStyle: false, // R2 usually works without path style; change if needed
      });
      configs.push({
        id: groupKey,
        prefix: info.prefix,
        suffix: info.suffix,
        bucket,
        endpoint,
        publicUrl,
        client,
        frontendOrigin,
        account,
      });
    } else {
      configs.push({
        id: groupKey,
        prefix: info.prefix,
        suffix: info.suffix,
        error: `Missing required vars (need BUCKET, ENDPOINT, ACCESS_KEY_ID, SECRET_ACCESS_KEY). Found: ${Object.keys(r).join(', ')}`,
        raw: r,
      });
    }
  }
  return configs;
}

const configs = makeConfigsFromEnv();

/* --------------------------
   Static / middleware
   -------------------------- */

app.use(express.static('public', { extensions: ['html'] }));

/* --------------------------
   Listing & pagination
   -------------------------- */

async function listAllObjectsPaginated(cfg, continuationToken) {
  const all = [];
  let token = continuationToken;
  try {
    while (true) {
      const params = { Bucket: cfg.bucket, MaxKeys: 1000 };
      if (token) params.ContinuationToken = token;
      const resp = await cfg.client.send(new ListObjectsV2Command(params));
      const contents = resp.Contents || [];
      for (const f of contents) all.push(f);
      if (!resp.IsTruncated) break;
      token = resp.NextContinuationToken;
    }
  } catch (err) {
    // bubble up error as exception
    throw err;
  }
  return all;
}

async function listFilesForConfig(cfg) {
  if (cfg.error) return [{ set: cfg.id, bucket: cfg.bucket || null, error: cfg.error }];
  try {
    const contents = await listAllObjectsPaginated(cfg);
    return contents.map((f) => {
      const key = String(f.Key);
      const url = buildPublicUrl(cfg, key);
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

/* --------------------------
   Endpoints
   -------------------------- */

app.get('/files', async (req, res) => {
  try {
    // Prevent caching of listing (avoid CDN/browser stale list)
    res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
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
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/files/:setId', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
    const setId = req.params.setId;
    const cfg = configs.find((c) => c.id === setId);
    if (!cfg) return res.status(404).json({ ok: false, error: 'set not found' });
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
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* --------------------------
   Prune endpoints (images only)
   -------------------------- */

function isImageKey(key) {
  return /\.(png|jpg|jpeg|gif|webp|bmp)(?:$|\?)/i.test(String(key || ''));
}

function chunkArray(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

app.get('/prune', async (req, res) => {
  const ttl = parseInt(req.query.ttl || '86400', 10);
  const dry = String(req.query.dry || 'false') === 'true';
  try {
    const results = [];
    const cutoff = Date.now() - (ttl * 1000);
    for (const cfg of configs) {
      if (cfg.error) { results.push({ set: cfg.id, error: cfg.error }); continue; }
      try {
        const objs = await listAllObjectsPaginated(cfg);
        const toDelete = objs
          .filter(o => o.Key && isImageKey(o.Key) && o.LastModified && new Date(o.LastModified).getTime() < cutoff)
          .map(o => String(o.Key));
        if (toDelete.length === 0) {
          results.push({ set: cfg.id, deleted: 0, dry, items: [] });
          continue;
        }
        if (dry) {
          results.push({ set: cfg.id, deleted: toDelete.length, dry: true, items: toDelete.slice(0, 1000) });
          continue;
        }
        const batches = chunkArray(toDelete, 1000);
        const deletedNames = [];
        const errors = [];
        for (const batch of batches) {
          const delReq = {
            Bucket: cfg.bucket,
            Delete: { Objects: batch.map(k => ({ Key: k })) },
          };
          try {
            const delResp = await cfg.client.send(new DeleteObjectsCommand(delReq));
            const deleted = delResp.Deleted || [];
            const err = delResp.Errors || [];
            deleted.forEach(d => deletedNames.push(d.Key));
            err.forEach(e => errors.push({ Key: e.Key, Code: e.Code, Message: e.Message }));
          } catch (e) {
            errors.push({ error: String(e) });
          }
        }
        results.push({ set: cfg.id, deleted: deletedNames.length, dry: false, items: deletedNames, errors });
      } catch (e) {
        results.push({ set: cfg.id, error: String(e) });
      }
    }
    res.json({ ok: true, ttl, dry: !!dry, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/prune/:setId', async (req, res) => {
  const setId = req.params.setId;
  const ttl = parseInt(req.query.ttl || '86400', 10);
  const dry = String(req.query.dry || 'false') === 'true';
  const cfg = configs.find(c => c.id === setId);
  if (!cfg) return res.status(404).json({ ok: false, error: 'set not found' });
  if (cfg.error) return res.status(400).json({ ok: false, error: cfg.error });
  try {
    const cutoff = Date.now() - (ttl * 1000);
    const objs = await listAllObjectsPaginated(cfg);
    const toDelete = objs
      .filter(o => o.Key && isImageKey(o.Key) && o.LastModified && new Date(o.LastModified).getTime() < cutoff)
      .map(o => String(o.Key));
    if (toDelete.length === 0) return res.json({ ok: true, set: cfg.id, deleted: 0, items: [] });
    if (dry) return res.json({ ok: true, set: cfg.id, deleted: toDelete.length, dry: true, items: toDelete.slice(0, 1000) });
    const batches = chunkArray(toDelete, 1000);
    const deletedNames = [];
    const errors = [];
    for (const batch of batches) {
      const delReq = { Bucket: cfg.bucket, Delete: { Objects: batch.map(k => ({ Key: k })) } };
      try {
        const delResp = await cfg.client.send(new DeleteObjectsCommand(delReq));
        const deleted = delResp.Deleted || [];
        const err = delResp.Errors || [];
        deleted.forEach(d => deletedNames.push(d.Key));
        err.forEach(e => errors.push({ Key: e.Key, Code: e.Code, Message: e.Message }));
      } catch (e) {
        errors.push({ error: String(e) });
      }
    }
    res.json({ ok: true, set: cfg.id, deleted: deletedNames.length, items: deletedNames, errors });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* --------------------------
   Start server
   -------------------------- */

app.listen(PORT, () => {
  console.log(`Server ready: http://localhost:${PORT}`);
  console.log('Discovered configs:', configs.map(c => ({ id: c.id, bucket: c.bucket, error: !!c.error })));
});
