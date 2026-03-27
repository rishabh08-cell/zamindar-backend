import type { PublishableContent, MissingField, CMSSchema, CMSFieldDefinition } from '../../types';

/**
 * Rule-based validation that runs BEFORE the AI agent.
 * Catches obvious issues without burning API calls.
 */
export function validateContent(
  content: Partial<PublishableContent>,
  cmsSchema?: CMSSchema | null
): MissingField[] {
  const missing: MissingField[] = [];

  // --- Required fields ---

  if (!content.title?.trim()) {
    missing.push({
      field: 'title',
      label: 'Title',
      reason: 'Every post needs a title',
      severity: 'required',
      suggestions: [],
      auto_fillable: false,
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
  }

  // --- SEO fields ---

  if (!content.seo?.meta_title) {
    missing.push({
      field: 'seo.meta_title',
      label: 'Meta Title',
      reason: 'No meta title — will use post title as fallback',
      severity: 'recommended',
      suggestions: content.title ? [content.title.slice(0, 60)] : [],
      auto_fillable: true,
    });
  } else if (content.seo.meta_title.length > 60) {
    missing.push({
      field: 'seo.meta_title',
      label: 'Meta Title',
      reason: `Meta title is ${content.seo.meta_title.length} chars (max 60)`,
      severity: 'recommended',
      suggestions: [content.seo.meta_title.slice(0, 57) + '...'],
      auto_fillable: true,
    });
  }

  if (!content.seo?.meta_description) {
    missing.push({
      field: 'seo.meta_description',
      label: 'Meta Description',
      reason: 'No meta description — search engines will auto-generate one',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  } else if (content.seo.meta_description.length > 160) {
    missing.push({
      field: 'seo.meta_description',
      label: 'Meta Description',
      reason: `Meta description is ${content.seo.meta_description.length} chars (max 160)`,
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  if (!content.slug) {
    missing.push({
      field: 'slug',
      label: 'URL Slug',
      reason: 'No slug — will be auto-generated from title',
      severity: 'recommended',
      suggestions: content.title
        ? [generateSlug(content.title)]
        : [],
      auto_fillable: true,
    });
  }

  // --- Open Graph ---

  if (!content.seo?.og_title) {
    missing.push({
      field: 'seo.og_title',
      label: 'OG Title',
      reason: 'No Open Graph title — social shares will use meta title',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  if (!content.seo?.og_description) {
    missing.push({
      field: 'seo.og_description',
      label: 'OG Description',
      reason: 'No Open Graph description — social shares will use meta description',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  if (!content.featured_image?.url && !content.seo?.og_image) {
    missing.push({
      field: 'featured_image',
      label: 'Featured Image',
      reason: 'No featured image — social shares and CMS listings will lack a visual',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: false,
    });
  }

  // --- Categories & Tags ---

  if (!content.categories?.length) {
    missing.push({
      field: 'categories',
      label: 'Categories',
      reason: 'No category selected',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  if (!content.tags?.length) {
    missing.push({
      field: 'tags',
      label: 'Tags',
      reason: 'No tags — helps with content discovery and SEO',
      severity: 'recommended',
      suggestions: [],
      auto_fillable: true,
    });
  }

  // --- Content quality ---

  const wordCount = content.body
    ? content.body.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean).length
    : 0;

  if (wordCount > 0 && wordCount < 300) {
    missing.push({
      field: 'body',
      label: 'Content Length',
      reason: `Content is only ${wordCount} words — consider expanding for better SEO`,
      severity: 'recommended',
      suggestions: [],
      auto_fillable: false,
    });
  }

  // --- CMS-specific required fields ---

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

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
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
