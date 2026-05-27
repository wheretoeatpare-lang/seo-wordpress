const Groq = require("groq-sdk");

const PROVIDER = process.env.AI_PROVIDER || "groq";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

/**
 * ImageAltChecker
 * Analyzes images in a WordPress post and generates SEO-friendly alt text
 * for any images that are missing alt text or have poor/empty descriptions.
 */
class ImageAltChecker {
  constructor() {
    if (PROVIDER === "groq") {
      this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else {
      const axios = require("axios");
      this.anthropic = axios.create({
        baseURL: "https://api.anthropic.com/v1",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      });
    }
  }

  async _chat(prompt, maxTokens = 600) {
    if (PROVIDER === "groq") {
      const res = await this.groq.chat.completions.create({
        model: GROQ_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0].message.content.trim();
    } else {
      const res = await this.anthropic.post("/messages", {
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return res.data.content[0].text.trim();
    }
  }

  _parseJSON(text) {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  }

  /**
   * Extract all <img> tags from post HTML content.
   * Returns array of { src, currentAlt, attachmentId (if data-id present) }
   */
  extractImages(htmlContent) {
    const imgRegex = /<img[^>]+>/gi;
    const images = [];
    let match;

    while ((match = imgRegex.exec(htmlContent)) !== null) {
      const tag = match[0];

      const srcMatch   = tag.match(/src=["']([^"']+)["']/i);
      const altMatch   = tag.match(/alt=["']([^"']*)["']/i);
      const idMatch    = tag.match(/data-id=["'](\d+)["']/i)
                      || tag.match(/wp-image-(\d+)/i)
                      || tag.match(/class="[^"]*wp-image-(\d+)[^"]*"/i);

      if (!srcMatch) continue;

      images.push({
        src:          srcMatch[1],
        currentAlt:   altMatch ? altMatch[1].trim() : null,
        attachmentId: idMatch  ? parseInt(idMatch[1]) : null,
        rawTag:       tag,
      });
    }

    return images;
  }

  /**
   * Decide which images actually need new alt text.
   * An image is "bad" if:
   *   - alt attribute is missing entirely
   *   - alt is empty string ""
   *   - alt is a filename-like string (e.g. "IMG_1234.jpg", "screenshot-2024")
   *   - alt is shorter than 5 characters
   */
  needsAltText(currentAlt) {
    if (currentAlt === null || currentAlt === undefined) return true;
    if (currentAlt.trim() === "")                        return true;
    if (currentAlt.length < 5)                           return true;
    // Looks like a filename
    if (/\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(currentAlt)) return true;
    // Looks like IMG_1234 or DSC0001 style
    if (/^(img|dsc|photo|image|screenshot|pic|figure)[_\-\s]?\d*/i.test(currentAlt.trim())) return true;
    return false;
  }

  /**
   * Generate SEO-friendly alt text for a single image using AI.
   * Uses the page title, surrounding page content, and image filename for context.
   */
  async generateAltText(image, pageTitle, pageContent, targetKeywords = []) {
    const filename = image.src.split("/").pop().replace(/[_-]/g, " ").replace(/\.[^.]+$/, "");
    const kwContext = targetKeywords.length > 0
      ? `\nTarget keywords to incorporate naturally if relevant: ${targetKeywords.join(", ")}`
      : "";

    const prompt = `You are an SEO expert. Generate concise, descriptive alt text for a web image.

PAGE TITLE: "${pageTitle}"
PAGE CONTENT SNIPPET: "${pageContent.slice(0, 400)}"
IMAGE FILENAME: "${filename}"
CURRENT ALT TEXT: "${image.currentAlt || "(none)"}"
${kwContext}

ALT TEXT RULES:
1. 8–15 words — descriptive but concise
2. Describe what is VISUALLY in the image (infer from filename + page context)
3. Include relevant keyword naturally only if it fits — never keyword-stuff
4. Do NOT start with "image of", "photo of", "picture of"
5. Do NOT include the filename literally
6. Be specific, not generic (e.g. "woman using laptop to edit WordPress blog" not "person on computer")

Return ONLY valid JSON, no markdown:
{
  "newAlt": "your generated alt text here",
  "reason": "one sentence explaining why this alt text is better",
  "keywordUsed": true or false
}`;

    const text = await this._chat(prompt, 300);
    return this._parseJSON(text);
  }

  /**
   * Full pipeline: scan all images in a post, generate alt text for those that need it.
   * Returns array of image fix objects.
   */
  async analyzePost(post, pageTitle, pageContent, targetKeywords = []) {
    const htmlContent = post.content?.rendered || "";
    const images = this.extractImages(htmlContent);

    if (images.length === 0) return [];

    const fixes = [];

    for (const img of images) {
      if (!this.needsAltText(img.currentAlt)) {
        // Already has good alt text — skip
        continue;
      }

      try {
        const result = await this.generateAltText(img, pageTitle, pageContent, targetKeywords);
        fixes.push({
          src:          img.src,
          attachmentId: img.attachmentId,
          currentAlt:   img.currentAlt,
          newAlt:       result.newAlt,
          reason:       result.reason,
          keywordUsed:  result.keywordUsed,
          rawTag:       img.rawTag,
        });
      } catch (err) {
        console.error(`  [AltChecker] Failed to generate alt for ${img.src}: ${err.message}`);
      }
    }

    return fixes;
  }
}

module.exports = ImageAltChecker;
