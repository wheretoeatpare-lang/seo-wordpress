const axios  = require("axios");
const sharp  = require("sharp");
const path   = require("path");
const os     = require("os");
const fs     = require("fs");

/**
 * ImageCompressor
 * Downloads images from WordPress, compresses them with Sharp,
 * then re-uploads to the WordPress Media Library via REST API.
 *
 * Compression strategy:
 *   - JPEG/JPG → quality 82, progressive, strip EXIF
 *   - PNG      → quality 90, compress level 9
 *   - WebP     → quality 80
 *   - Only replaces if new file is at least 15% smaller than original
 */
class ImageCompressor {
  constructor(siteUrl, username, appPassword) {
    this.siteUrl = siteUrl.replace(/\/$/, "");
    this.auth = { username, password: appPassword };
    this.client = axios.create({
      baseURL: `${this.siteUrl}/wp-json/wp/v2`,
      auth: this.auth,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Download image bytes from any URL */
  async _download(url) {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: { "User-Agent": "SEO-Monitor-Bot/1.0" },
    });
    return {
      data:        Buffer.from(res.data),
      contentType: res.headers["content-type"] || "image/jpeg",
    };
  }

  /** Detect format from URL or content-type */
  _detectFormat(url, contentType) {
    const ext = path.extname(url.split("?")[0]).toLowerCase().replace(".", "");
    if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return ext === "jpg" ? "jpeg" : ext;
    if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpeg";
    if (contentType.includes("png"))  return "png";
    if (contentType.includes("webp")) return "webp";
    return "jpeg"; // safe fallback
  }

  /** Compress image buffer using Sharp */
  async _compress(buffer, format) {
    let pipeline = sharp(buffer);

    switch (format) {
      case "jpeg":
        pipeline = pipeline.jpeg({ quality: 82, progressive: true, mozjpeg: true });
        break;
      case "png":
        pipeline = pipeline.png({ quality: 90, compressionLevel: 9 });
        break;
      case "webp":
        pipeline = pipeline.webp({ quality: 80 });
        break;
      default:
        // Unknown format — return as-is
        return buffer;
    }

    return await pipeline.toBuffer();
  }

  /**
   * Compress a single attachment.
   * Returns { attachmentId, url, originalSize, newSize, savedBytes, savedPct, skipped, reason }
   */
  async compressAttachment(attachmentId) {
    // 1. Fetch attachment metadata
    const meta = await this.client.get(`/media/${attachmentId}`);
    const mediaUrl  = meta.data.source_url;
    const mimeType  = meta.data.mime_type || "image/jpeg";
    const filename  = path.basename(mediaUrl.split("?")[0]);

    if (!mediaUrl) {
      return { attachmentId, skipped: true, reason: "No source URL found" };
    }

    // Skip SVG and GIF (lossless/animated — not worth compressing)
    if (mimeType.includes("svg") || mimeType.includes("gif")) {
      return { attachmentId, url: mediaUrl, skipped: true, reason: `Format ${mimeType} skipped (SVG/GIF not compressed)` };
    }

    // 2. Download original
    const { data: originalBuffer, contentType } = await this._download(mediaUrl);
    const format = this._detectFormat(mediaUrl, contentType);
    const originalSize = originalBuffer.length;

    // 3. Compress
    const compressedBuffer = await this._compress(originalBuffer, format);
    const newSize = compressedBuffer.length;
    const savedBytes = originalSize - newSize;
    const savedPct   = ((savedBytes / originalSize) * 100).toFixed(1);

    // 4. Skip if savings < 15%
    if (savedBytes < 0 || (savedBytes / originalSize) < 0.15) {
      return {
        attachmentId,
        url: mediaUrl,
        originalSize,
        newSize,
        savedBytes,
        savedPct,
        skipped: true,
        reason: `Only ${savedPct}% savings — not worth replacing (threshold: 15%)`,
      };
    }

    // 5. Re-upload compressed image to WordPress media endpoint
    const { FormData, Blob } = require("buffer"); // Node 18+; fall back below if needed

    // Build multipart form manually for Node.js compatibility
    const boundary = `----FormBoundary${Date.now()}`;
    const mimeTypeForUpload = format === "jpeg" ? "image/jpeg"
                            : format === "png"  ? "image/png"
                            : "image/webp";

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeTypeForUpload}\r\n\r\n`,
    ];

    const header  = Buffer.from(parts[0]);
    const footer  = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body    = Buffer.concat([header, compressedBuffer, footer]);

    const uploadRes = await axios.post(
      `${this.siteUrl}/wp-json/wp/v2/media/${attachmentId}`,
      body,
      {
        auth: this.auth,
        headers: {
          "Content-Type":        `multipart/form-data; boundary=${boundary}`,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length":      body.length,
        },
      }
    );

    return {
      attachmentId,
      url:          mediaUrl,
      newUrl:       uploadRes.data?.source_url || mediaUrl,
      originalSize,
      newSize,
      savedBytes,
      savedPct,
      skipped: false,
    };
  }

  /**
   * Compress all attachments for a given list of attachment IDs.
   * Returns array of result objects.
   */
  async compressMany(attachmentIds, logFn = console.log) {
    const results = [];

    for (const id of attachmentIds) {
      try {
        logFn(`  [Compress] Processing attachment ID ${id}...`);
        const result = await this.compressAttachment(id);

        if (result.skipped) {
          logFn(`  [Compress] ⏭ Skipped ${id}: ${result.reason}`);
        } else {
          logFn(`  [Compress] ✓ Compressed ${id}: ${_formatBytes(result.originalSize)} → ${_formatBytes(result.newSize)} (saved ${result.savedPct}%)`);
        }

        results.push(result);
      } catch (err) {
        logFn(`  [Compress] ✗ Error on ${id}: ${err.message}`);
        results.push({ attachmentId: id, skipped: true, error: true, reason: err.message });
      }

      // Small delay to avoid hammering the server
      await new Promise(r => setTimeout(r, 500));
    }

    return results;
  }

  /**
   * Get all media attachment IDs used in a post's HTML content.
   * Extracts wp-image-NNNN class IDs and data-id attributes.
   */
  static extractAttachmentIds(htmlContent) {
    const ids = new Set();
    const patterns = [
      /wp-image-(\d+)/g,
      /data-id="(\d+)"/g,
      /data-attachment-id="(\d+)"/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(htmlContent)) !== null) ids.add(parseInt(m[1]));
    }
    return [...ids];
  }
}

function _formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

module.exports = ImageCompressor;
