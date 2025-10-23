import express from "express";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

const {
  R2_REGION,
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_URL,
} = process.env;

// ✅ Initialiser le client S3 (Cloudflare R2)
const s3 = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ✅ Servir le frontend (index.html + assets)
app.use(express.static("public"));

// ✅ Route pour lister les fichiers R2
app.get("/files", async (req, res) => {
  try {
    const data = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
      })
    );

    // ✅ Crée la liste complète des fichiers
    const allFiles =
      data.Contents?.map((file) => ({
        name: file.Key,
        size: file.Size,
        lastModified: file.LastModified,
        url: `${R2_PUBLIC_URL.replace(/\/$/, "")}/${encodeURIComponent(file.Key)}`,
      })) || [];

    // ✅ Vérifie seulement les URL valides (status 200)
    const validFiles = [];
    for (const file of allFiles) {
      try {
        const resp = await fetch(file.url, { method: "HEAD" });
        if (resp.ok) validFiles.push(file);
      } catch (_) {}
    }

    res.json(validFiles);
  } catch (error) {
    console.error("❌ Erreur lors du listing:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () =>
  console.log(`✅ Serveur prêt sur http://localhost:${PORT}`)
);
