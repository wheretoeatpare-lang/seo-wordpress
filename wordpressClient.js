const axios = require("axios");

// Supports Yoast SEO, RankMath, or fallback to native WP title/excerpt
const SEO_PLUGIN = process.env.WP_SEO_PLUGIN || "yoast"; // "yoast" | "rankmath" | "native"

class WordPressClient {
  constructor(siteUrl, username, appPassword) {
    if (!siteUrl)      throw new Error("Missing env var: WP_SITE_URL");
    if (!username)     throw new Error("Missing env var: WP_USERNAME");
    if (!appPassword)  throw new Error("Missing env var: WP_APP_PASSWORD");
    this.siteUrl = siteUrl.replace(/\/$/, "");
    this.client = axios.create({
      baseURL: `${this.siteUrl}/wp-json/wp/v2`,
      auth: { username, password: appPassword },
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Fetch all published posts + pages ────────────────────────────────────────
  async getAllPages() {
    const results = [];

    for (const postType of ["pages", "posts"]) {
      let page = 1;
      while (true) {
        const res = await this.client.get(`/${postType}`, {
          params: { per_page: 100, page, status: "publish", _fields: "id,slug,link,title,excerpt,meta,yoast_head_json" },
        });
        results.push(...res.data.map(p => ({ ...p, _postType: postType })));
        if (res.data.length < 100) break;
        page++;
      }
    }

    console.log(`  [WP] Found ${results.length} published pages/posts`);
    return results;
  }

  // ── Get single post/page with full content for SEO analysis ──────────────────
  async getPost(id, postType = "pages") {
    const res = await this.client.get(`/${postType}/${id}`, {
      params: { _fields: "id,slug,link,title,excerpt,content,meta,yoast_head_json" },
    });
    return res.data;
  }

  // ── Parse SEO fields from a WP post object ───────────────────────────────────
  parseSEO(post) {
    let title = "";
    let metaDesc = "";

    if (SEO_PLUGIN === "yoast" && post.yoast_head_json) {
      title    = post.yoast_head_json.title        || post.title?.rendered || "";
      metaDesc = post.yoast_head_json.description  || "";
    } else if (SEO_PLUGIN === "rankmath" && post.meta) {
      title    = post.meta.rank_math_title          || post.title?.rendered || "";
      metaDesc = post.meta.rank_math_description    || "";
    } else {
      // Native WP fallback — title + excerpt as meta desc
      title    = post.title?.rendered || "";
      metaDesc = _stripTags(post.excerpt?.rendered || "");
    }

    return {
      id: post.id,
      postType: post._postType || "pages",
      slug: post.slug,
      url: post.link,
      title: _stripTags(title).trim(),
      metaDesc: metaDesc.trim(),
    };
  }

  // ── Extract plain-text body for AI analysis ───────────────────────────────────
  getPageText(post) {
    const raw = post.content?.rendered || post.excerpt?.rendered || "";
    return _stripTags(raw).replace(/\s+/g, " ").trim().slice(0, 500);
  }

  // ── Update alt text on a media attachment ────────────────────────────────────
  async updateImageAlt(attachmentId, newAlt) {
    await this.client.post(`/media/${attachmentId}`, {
      alt_text: newAlt,
    });
  }

  // ── Get all media attachments for a post (by post parent) ────────────────────
  async getPostMedia(postId) {
    try {
      const res = await this.client.get(`/media`, {
        params: { parent: postId, per_page: 50, _fields: "id,source_url,alt_text,mime_type" },
      });
      return res.data;
    } catch {
      return [];
    }
  }

  // ── Apply new SEO fields back to WordPress ────────────────────────────────────
  async updateSEO(id, postType, newTitle, newMetaDesc) {
    let payload = {};

    if (SEO_PLUGIN === "yoast") {
      // Yoast exposes meta fields via REST when "yoast/v1" namespace is enabled
      // We use the standard meta object that Yoast registers
      payload = {
        meta: {
          _yoast_wpseo_title:    newTitle,
          _yoast_wpseo_metadesc: newMetaDesc,
        },
      };
    } else if (SEO_PLUGIN === "rankmath") {
      payload = {
        meta: {
          rank_math_title:       newTitle,
          rank_math_description: newMetaDesc,
        },
      };
    } else {
      // Native fallback: update WP title + excerpt
      payload = {
        title:   newTitle,
        excerpt: newMetaDesc,
      };
    }

    await this.client.post(`/${postType}/${id}`, payload);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#039;/g,"'").trim();
}

module.exports = WordPressClient;
