import type { PublishableContent, MissingField, CMSSchema, CMSFieldDefinition } from '../../types';

/**
 * Stop words to remove from slugs (Appendix B of the playbook).
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'shall', 'should', 'may', 'might', 'can', 'could',
]);

/**
 * Character limits from Appendix A of the playbook.
 */
const LIMITS = {
  META_TITLE_MIN: 30,
  META_TITLE_MAX: 60,
  META_DESC_MIN: 120,
  META_DESC_MAX: 160,
  OG_TITLE_MIN: 30,
  OG_TITLE_MAX: 90,
  OG_DESC_MIN: 50,
  OG_DESC_MAX: 200,
  ALT_TEXT_MIN: 5,
  ALT_TEXT_MAX: 125,
  H1_MIN: 20,
  H1_MAX: 70,
  SLUG_MAX_WORDS: 5,
  MIN_WORD_COUNT: 300,
  MAX_TAGS: 5,
  MAX_CATEGORIES: 1,
  MIN_INTERNAL_LINKS: 3,
} as const;

/**
 * Rule-based validation aligned with the SEO Agent Playbook.
 * Runs BEFORE the AI agent to catch obvious issues without burning API calls.
 * References playbook sections in each rule for traceability.
 */
export function validateContent(
  content: Partial<PublishableContent>,
  cmsSchema?: CMSSchema | null
): MissingField[] {
  const missing: MissingField[] = [];
  const bodyText = content.body
    ? content.body.replace(/<[^>]*>/g, '')
    : '';
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  // ========================================
  // Section 8.1: Structure & Content
  // ========================================

  if (!content.title?.trim()) {
    missing.push({
      field: 'title',
      label: 'Title / H1',
      reason: 'Every post needs a title (Section 3.1: exactly one H1 per page)',
      severity: 'required',
      suggestions: [],
      auto_fillable: false,
    });
  } else if (content.title.length < LIMITS.H1_MIN) {
    missing.push({
      field: 'title',
      label: 'Title / H1',
      reason: `Title is ${content.title.length} chars — minimum ${LIMITS.H1_MIN} (Appendix A)`,
      severity: 'recommended',
      suggestions: [],
      auto_fillable: false,
    });
  } else if (content.title.length > LIMITS.H1_MAX) {
    missing.push({
      field: 'title',
      label: 'Title / H1',
      reason: `Title is ${content.title.length} chars — maximum ${LIMITS.H1_MAX} (Appendix A)`,
      severity: 'recommended',
      suggestions: [content.title.slice(0, LIMITS.H1_MAX)],
      auto_fillable: true,
    });
  }

  if (!content.body?.trim()) {
    missing.push({
      field: 'body',
      label: 'Content Body',
      reason: 'Post has no content',
      severity: 'required',
      suggestions: [],
      auto_fillable: false,
    });
  } else if (wordCount < LIMITS.MIN_WORD_COUNT) {
    missing.push({
      field: 'body',
      label: 'Content Length',
      reason: `Content is only ${wordCount} words — absolute minimum is ${LIMITS.MIN_WORD_COUNT} (Section 8.1)`,
      severity: 'recommended',
      suggestions: [],
      auto_fillable: false,
    });
  }

  // ========================================
  // Section 4.1: Meta Title
  // ========================================

  if (!content.seo?.meta_title) {
    missing.push({
      field: 'seo.meta_title',
      label: 'Meta Title',
      reason: 'No meta title — required for SERPs (Section 4.1)',
      severity: 'recommended',
      suggestions: content.title ? [content.title.slice(0, LIMITS.META_TITLE_MAX)] : [],
      auto_fillable: true,
    });
  } else {
    const len = content.seo.meta_title.length;
    if (len < LIMITS.META_TITLE_MIN) {
      missing.push({
        field: 'seo.meta_title',
        label: 'Meta Title',
        reason: `Meta title is ${len} chars — minimum ${LIMITS.META_TITLE_MIN} (Appendix A)`,
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    } else if (len > LIMITS.META_TITLE_MAX) {
      missing.push({
        field: 'seo.meta_title',
        label: 'Meta Title',
        reason: `Meta title is ${len} chars — will be truncated at ${LIMITS.META_TITLE_MAX} (Section 4.1)`,
        severity: 'recommended',
        suggestions: [content.seo.meta_title.slice(0, 57) + '...'],
        auto_fillable: true,
      });
    }

    // Check: meta title should not be identical to H1 (Section 3.1)
    if (content.title && content.seo.meta_title === content.title) {
      missing.push({
        field: 'seo.meta_title',
        label: 'Meta Title',
        reason: 'Meta title is identical to H1 — they should differ (Section 3.1)',
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    }
  }

  // ========================================
  // Section 4.2: Meta Description
  // ========================================

  if (!content.seo?.meta_description) {
    missing.push({
      field: 'seo.meta_description',
      label: 'Meta Description',
      reason: 'No meta description — search engines will auto-generate one (Section 4.2)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  } else {
    const len = content.seo.meta_description.length;
    if (len < LIMITS.META_DESC_MIN) {
      missing.push({
        field: 'seo.meta_description',
        label: 'Meta Description',
        reason: `Meta description is ${len} chars — minimum ${LIMITS.META_DESC_MIN} (Appendix A)`,
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    } else if (len > LIMITS.META_DESC_MAX) {
      missing.push({
        field: 'seo.meta_description',
        label: 'Meta Description',
        reason: `Meta description is ${len} chars — will be truncated at ${LIMITS.META_DESC_MAX} (Section 4.2)`,
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    }

    // Check: meta description must not duplicate meta title (Section 4.2)
    if (content.seo?.meta_title && content.seo.meta_description === content.seo.meta_title) {
      missing.push({
        field: 'seo.meta_description',
        label: 'Meta Description',
        reason: 'Meta description duplicates the meta title — must be different (Section 4.2)',
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    }
  }

  // ========================================
  // Section 4.3: Slug
  // ========================================

  if (!content.slug) {
    missing.push({
      field: 'slug',
      label: 'URL Slug',
      reason: 'No slug — will be auto-generated from title (Section 4.3)',
      severity: 'recommended',
      suggestions: content.title ? [generateSlug(content.title)] : [],
      auto_fillable: true,
    });
  } else {
    // Validate slug format (Appendix C)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(content.slug)) {
      missing.push({
        field: 'slug',
        label: 'URL Slug',
        reason: 'Slug must be lowercase, hyphenated, no special characters (Section 4.3)',
        severity: 'recommended',
        suggestions: [generateSlug(content.slug)],
        auto_fillable: true,
      });
    }

    const slugWords = content.slug.split('-');
    if (slugWords.length > LIMITS.SLUG_MAX_WORDS) {
      missing.push({
        field: 'slug',
        label: 'URL Slug',
        reason: `Slug has ${slugWords.length} words — max ${LIMITS.SLUG_MAX_WORDS} (Section 4.3)`,
        severity: 'recommended',
        suggestions: [slugWords.slice(0, LIMITS.SLUG_MAX_WORDS).join('-')],
        auto_fillable: true,
      });
    }

    // Check for stop words in slug
    const stopWordsInSlug = slugWords.filter((w) => STOP_WORDS.has(w));
    if (stopWordsInSlug.length > 0) {
      missing.push({
        field: 'slug',
        label: 'URL Slug',
        reason: `Slug contains stop words: ${stopWordsInSlug.join(', ')} — remove them (Section 4.3, Appendix B)`,
        severity: 'recommended',
        suggestions: [slugWords.filter((w) => !STOP_WORDS.has(w)).join('-')],
        auto_fillable: true,
      });
    }
  }

  // ========================================
  // Section 4.4: Open Graph & Social Meta
  // ========================================

  if (!content.seo?.og_title) {
    missing.push({
      field: 'seo.og_title',
      label: 'OG Title',
      reason: 'No Open Graph title — social shares will use meta title (Section 4.4)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  } else if (content.seo.og_title.length > LIMITS.OG_TITLE_MAX) {
    missing.push({
      field: 'seo.og_title',
      label: 'OG Title',
      reason: `OG title is ${content.seo.og_title.length} chars — max ${LIMITS.OG_TITLE_MAX} (Appendix A)`,
      severity: 'recommended',
      suggestions: [content.seo.og_title.slice(0, LIMITS.OG_TITLE_MAX)],
      auto_fillable: true,
    });
  }

  if (!content.seo?.og_description) {
    missing.push({
      field: 'seo.og_description',
      label: 'OG Description',
      reason: 'No Open Graph description — social shares will use meta description (Section 4.4)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  } else if (content.seo.og_description.length > LIMITS.OG_DESC_MAX) {
    missing.push({
      field: 'seo.og_description',
      label: 'OG Description',
      reason: `OG description is ${content.seo.og_description.length} chars — max ${LIMITS.OG_DESC_MAX} (Section 4.4)`,
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  if (!content.featured_image?.url && !content.seo?.og_image) {
    missing.push({
      field: 'featured_image',
      label: 'Featured Image / OG Image',
      reason: 'No featured image — og:image must be set, minimum 1200×630px (Section 4.4)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: false,
    });
  }

  // ========================================
  // Section 4.5: Canonical Tags
  // ========================================

  if (!content.seo?.canonical_url) {
    missing.push({
      field: 'seo.canonical_url',
      label: 'Canonical URL',
      reason: 'Every page must have a self-referencing canonical tag (Section 4.5)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  // ========================================
  // Section 7: Categories & Tags
  // ========================================

  if (!content.categories?.length) {
    missing.push({
      field: 'categories',
      label: 'Categories',
      reason: 'No category selected — max 1 primary category per post (Section 7.1)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  } else if (content.categories.length > LIMITS.MAX_CATEGORIES) {
    missing.push({
      field: 'categories',
      label: 'Categories',
      reason: `${content.categories.length} categories assigned — max ${LIMITS.MAX_CATEGORIES} per post (Section 7.1)`,
      severity: 'recommended',
      suggestions: [],
      auto_fillable: false,
    });
  }

  if (!content.tags?.length) {
    missing.push({
      field: 'tags',
      label: 'Tags',
      reason: 'No tags — helps with content discovery, max 5 per post (Section 7.2)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  } else if (content.tags.length > LIMITS.MAX_TAGS) {
    missing.push({
      field: 'tags',
      label: 'Tags',
      reason: `${content.tags.length} tags assigned — max ${LIMITS.MAX_TAGS} per post (Section 7.2)`,
      severity: 'recommended',
      suggestions: [],
      auto_fillable: false,
    });
  }

  // ========================================
  // Section 3.2: Keyword Placement
  // ========================================

  if (content.seo?.focus_keyword && content.body) {
    const keyword = content.seo.focus_keyword.toLowerCase();
    const first100Words = bodyText.split(/\s+/).slice(0, 100).join(' ').toLowerCase();

    if (!first100Words.includes(keyword)) {
      missing.push({
        field: 'seo.focus_keyword',
        label: 'Keyword in First 100 Words',
        reason: `Primary keyword "${content.seo.focus_keyword}" not found in the first 100 words (Section 3.2)`,
        severity: 'recommended',
        suggestions: [],
        auto_fillable: false,
      });
    }

    if (content.seo?.meta_title && !content.seo.meta_title.toLowerCase().includes(keyword)) {
      missing.push({
        field: 'seo.meta_title',
        label: 'Keyword in Meta Title',
        reason: `Primary keyword "${content.seo.focus_keyword}" not in meta title (Section 3.2)`,
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    }

    if (content.seo?.meta_description && !content.seo.meta_description.toLowerCase().includes(keyword)) {
      missing.push({
        field: 'seo.meta_description',
        label: 'Keyword in Meta Description',
        reason: `Primary keyword "${content.seo.focus_keyword}" not in meta description (Section 3.2)`,
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    }

    if (content.slug && !content.slug.includes(keyword.replace(/\s+/g, '-'))) {
      missing.push({
        field: 'slug',
        label: 'Keyword in Slug',
        reason: `Primary keyword "${content.seo.focus_keyword}" not in slug (Section 4.3)`,
        severity: 'recommended',
        suggestions: [],
        auto_fillable: true,
      });
    }

    // Check for keyword stuffing (Section 3.2: >3x per 500 words is overstuffed)
    if (wordCount >= 500) {
      const keywordRegex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = bodyText.match(keywordRegex);
      const keywordCount = matches ? matches.length : 0;
      const per500 = (keywordCount / wordCount) * 500;

      if (per500 > 3) {
        missing.push({
          field: 'seo.focus_keyword',
          label: 'Keyword Density',
          reason: `Keyword "${content.seo.focus_keyword}" appears ~${Math.round(per500)}x per 500 words — likely overstuffed (Section 3.2)`,
          severity: 'recommended',
          suggestions: ['Reduce keyword frequency, use synonyms and natural variations'],
          auto_fillable: false,
        });
      }
    }
  }

  // ========================================
  // Section 8.2: Media — alt text checks
  // ========================================

  if (content.featured_image?.url && !content.featured_image.alt) {
    missing.push({
      field: 'featured_image.alt',
      label: 'Featured Image Alt Text',
      reason: 'Featured image has no alt text (Section 3.4)',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  // ========================================
  // Section 5: Schema / Structured Data
  // ========================================

  if (!content.seo?.structured_data) {
    missing.push({
      field: 'seo.structured_data',
      label: 'Schema Markup',
      reason: 'No structured data (JSON-LD) — add Article/BlogPosting schema (Section 5)',
      severity: 'recommended',
      suggestions: ['Article', 'BlogPosting', 'HowTo', 'FAQPage'],
      auto_fillable: true,
    });
  }

  // ========================================
  // CMS-specific required fields
  // ========================================

  if (cmsSchema) {
    for (const contentType of cmsSchema.content_types) {
      for (const field of contentType.fields) {
        if (field.required && !hasField(content, field)) {
          missing.push({
            field: field.key,
            label: field.label,
            reason: `Required by CMS (${contentType.name})`,
            severity: 'required',
            suggestions: [],
            auto_fillable: canAutoFill(field),
          });
        }
      }
    }
  }

  return missing;
}

/**
 * Generate a slug following Section 4.3 and Appendix B rules.
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter((word) => !STOP_WORDS.has(word) && word.length > 0)
    .slice(0, LIMITS.SLUG_MAX_WORDS)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function hasField(content: Partial<PublishableContent>, field: CMSFieldDefinition): boolean {
  const fieldMap: Record<string, unknown> = {
    title: content.title,
    content: content.body,
    body: content.body,
    slug: content.slug,
    excerpt: content.excerpt,
    status: content.status,
    featured_media: content.featured_image,
    featured_image: content.featured_image,
  };

  const value = fieldMap[field.key] ?? content.custom_fields?.[field.key];
  return value !== undefined && value !== null && value !== '';
}

function canAutoFill(field: CMSFieldDefinition): boolean {
  return ['text', 'richtext'].includes(field.type);
}
