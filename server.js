require('dotenv').config();
const express = require('express');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Normalize URL: remove surrounding quotes/whitespace, ensure http/https,
 * trim duplicate slashes at end.
 */
function normalizePublicUrl(raw) {
  if (!raw) return '';
  let u = String(raw).trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  // ensure scheme
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u;
  }
  // remove double slashes after protocol (e.g. "https:////")
  u = u.replace(/^(https?:)\/+/i, (m, p1) => p1 + '//');
  // remove trailing slashes
  u = u.replace(/\/+$/g, '');
  return u;
}

/**
 * Join base + path safely
 */
function joinUrl(base, path) {
  if (!base) return path ? `${encodeURIComponent(path)}` : '';
  const b = String(base).replace(/\/+$/g, '');
  const p = String(path || '').replace(/^\/+/g, '');
  return p ? `${b}/${encodeURIComponent(p)}` : b;
}

/**
 * Scan process.env for keys that look like R2 / RE sets.
 *
 * Supports patterns like:
 *  - R2_BUCKET
 *  - R2_BUCKET_2
 *  - R2_2_BUCKET
 *  - R2_ACCESS_KEY_ID_3
 *  - RE_BUCKET_4
 *
 * Groups are keyed by `${prefix}${suffix ? '_' + suffix : ''}` (e.g. "R2", "R2_2")
 */
function makeConfigsFromEnv() {
  const wantedProps = [
    'BUCKET',
    'ENDPOINT',
    'ACCESS_KEY_ID',
    'ACCESS_KEY',
    'SECRET_ACCESS_KEY',
    'SECRET',
    'PUBLIC_URL',
    'REGION',
    'FRONTEND_ORIGIN',
    'CF_ACCOUNT_ID',
  ];

  const groups = {}; // key -> { prefix, suffix, raw: {PROP: value, ...} }

  for (const [k, v] of Object.entries(process.env)) {
    // normalize key
    const key = k.trim();

    // Pattern A: PREFIX[_]PROP[_]SUFFIX  e.g. R2_BUCKET_2
    let m = key.match(/^([A-Z0-9]+?)_([A-Z0-9_]+?)(?:_([0-9]+))?$/i);
    if (m) {
      const prefix = m[1];
      const prop = m[2];
      const suffix = m[3] || '';
      // Accept only if prop is one we expect (or maps to one)
      const up = prop.toUpperCase();
      if (wantedProps.some(w => up === w || up === w.replace(/_/g, ''))) {
        const groupKey = `${prefix}${suffix ? '_' + suffix : ''}`;
        groups[groupKey] = groups[groupKey] || { prefix, suffix, raw: {} };
        groups[groupKey].raw[up] = v;
        continue;
      }
    }

    // Pattern B: PREFIX[_]SUFFIX[_]PROP  e.g. R2_2_BUCKET or R2_2_ACCESS_KEY_ID
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

  // Map groups into final configs (try to be forgiving with property names)
  const configs = [];
  for (const [groupKey, info] of Object.entries(groups)) {
    const r = info.raw;
    // Normalize alternative names:
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
        credentials: {
          accessKeyId: accessKey,
          secretAccessKey: secretKey,
        },
        forcePathStyle: false,
      });

      configs.push({
        id: groupKey, // e.g. "R2", "R2_2", "RE_3"
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
      // Keep a lightweight "error" representation so frontend can show misconfigured sets
      configs.push({
        id: groupKey,
        prefix: info.prefix,
        suffix: info.suffix,
        error: `Missing required vars (need BUCKET, ENDPOINT, ACCESS_KEY_ID, SECRET_ACCESS_KEY). Found: ${Object.keys(r).join(', ')}`,
        raw: r,
      });
    }
  }

  // If nothing found, add fallback attempt using older SUFFIXES convention (empty set)
  if (configs.length === 0) {
    // no config discovered
  }

  return configs;
}

const configs = makeConfigsFromEnv();

app.use(express.static('public', { extensions: ['html'] }));

async function listFilesForConfig(cfg, maxKeys = 1000) {
  if (cfg.error) return [{ set: cfg.id, bucket: cfg.bucket || null, error: cfg.error }];
  try {
    const data = await cfg.client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: maxKeys }));
    const contents = data.Contents || [];
    return contents.map((f) => {
      const key = String(f.Key);
      const url = cfg.publicUrl ? joinUrl(cfg.publicUrl, key) : `${encodeURIComponent(key)}`;
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

app.listen(PORT, () => {
  console.log(`Server ready: http://localhost:${PORT}`);
  console.log('Discovered configs:', configs.map(c => ({ id: c.id, bucket: c.bucket, error: c.error ? true : false })));
});
