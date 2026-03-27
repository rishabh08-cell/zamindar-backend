import { BaseCMSAdapter } from './base';
import type {
  CMSAdapterConfig,
  CMSPlatform,
  CMSSchema,
  CMSTaxonomyTerm,
  CMSContentType,
  CMSCustomField,
  CMSFieldDefinition,
  PublishableContent,
  AgentPublishResult,
  ContentImage,
} from '../../../types';

interface StrapiEntry {
  id: number;
  documentId?: string;
  attributes?: Record<string, unknown>;
  // Strapi v5 flat response
  [key: string]: unknown;
}

interface StrapiContentTypeSchema {
  uid: string;
  apiID: string;
  schema: {
    displayName: string;
    attributes: Record<string, { type: string; required?: boolean; default?: unknown }>;
  };
}

interface StrapiMediaResponse {
  id: number;
  url: string;
}

export class StrapiAdapter extends BaseCMSAdapter {
  readonly platform: CMSPlatform = 'strapi';
  private apiPrefix = '/api';

  async connect(config: CMSAdapterConfig): Promise<{ success: boolean; site_name: string; error?: string }> {
    this.siteUrl = config.site_url.replace(/\/+$/, '');
    this.credentials = config.credentials;

    try {
      // Validate connection by checking content types
      await this.strapiApi<unknown>(`${this.apiPrefix}/content-type-builder/content-types`);
      this.connected = true;

      // Use site URL as name fallback
      const siteName = new URL(this.siteUrl).hostname;
      return { success: true, site_name: siteName };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      return { success: false, site_name: '', error: message };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.strapiApi<unknown>(`${this.apiPrefix}/users/me`);
      return true;
    } catch {
      return false;
    }
  }

  async fetchSchema(): Promise<CMSSchema> {
    this.ensureConnected();

    const response = await this.strapiApi<{ data: StrapiContentTypeSchema[] }>(
      `${this.apiPrefix}/content-type-builder/content-types`
    );

    const contentTypes: CMSContentType[] = [];
    const customFields: CMSCustomField[] = [];

    for (const ct of response.data) {
      // Only include API content types (not admin/plugin types)
      if (!ct.uid.startsWith('api::')) continue;

      const fields: CMSFieldDefinition[] = Object.entries(ct.schema.attributes).map(([key, attr]) => ({
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
        type: this.mapStrapiFieldType(attr.type),
        required: attr.required || false,
        default: attr.default,
      }));

      contentTypes.push({
        slug: ct.apiID,
        name: ct.schema.displayName,
        fields,
      });

      // Collect component fields as custom fields
      const componentFields = Object.entries(ct.schema.attributes)
        .filter(([, attr]) => attr.type === 'component' || attr.type === 'dynamiczone');

      for (const [key, attr] of componentFields) {
        customFields.push({
          key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
          type: attr.type,
          platform_meta: { strapi_uid: ct.uid },
        });
      }
    }

    return {
      content_types: contentTypes,
      categories: [],
      tags: [],
      custom_fields: customFields,
      fetched_at: new Date().toISOString(),
    };
  }

  async createPost(content: PublishableContent): Promise<AgentPublishResult> {
    this.ensureConnected();

    try {
      const contentType = this.resolveContentType(content);
      const data = this.toStrapiData(content);

      const result = await this.strapiApi<{ data: StrapiEntry }>(
        `${this.apiPrefix}/${contentType}`,
        {
          method: 'POST',
          body: JSON.stringify({ data }),
        }
      );

      const entry = result.data;
      const entryId = entry.documentId || String(entry.id);
      const postUrl = `${this.siteUrl}${this.apiPrefix}/${contentType}/${entryId}`;

      return {
        success: true,
        cms_post_id: entryId,
        cms_post_url: postUrl,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create entry',
      };
    }
  }

  async updatePost(cmsPostId: string, content: PublishableContent): Promise<AgentPublishResult> {
    this.ensureConnected();

    try {
      const contentType = this.resolveContentType(content);
      const data = this.toStrapiData(content);

      const result = await this.strapiApi<{ data: StrapiEntry }>(
        `${this.apiPrefix}/${contentType}/${cmsPostId}`,
        {
          method: 'PUT',
          body: JSON.stringify({ data }),
        }
      );

      const entry = result.data;
      const entryId = entry.documentId || String(entry.id);

      return {
        success: true,
        cms_post_id: entryId,
        cms_post_url: `${this.siteUrl}${this.apiPrefix}/${contentType}/${entryId}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to update entry',
      };
    }
  }

  async deletePost(cmsPostId: string): Promise<{ success: boolean; error?: string }> {
    this.ensureConnected();

    try {
      // Default to 'articles' — in real usage, content type should be tracked per publication
      await this.strapiApi(`${this.apiPrefix}/articles/${cmsPostId}`, { method: 'DELETE' });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to delete entry' };
    }
  }

  async getPost(cmsPostId: string): Promise<PublishableContent | null> {
    this.ensureConnected();

    try {
      const result = await this.strapiApi<{ data: StrapiEntry }>(
        `${this.apiPrefix}/articles/${cmsPostId}?populate=*`
      );
      return this.fromStrapiEntry(result.data);
    } catch {
      return null;
    }
  }

  async uploadMedia(image: ContentImage, fileBuffer?: Buffer): Promise<{ id: number; url: string }> {
    this.ensureConnected();

    const formData = new FormData();

    if (fileBuffer) {
      const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
      formData.append('files', blob, image.title || 'upload.jpg');
    } else if (image.url) {
      // Fetch the image and upload it
      const response = await fetch(image.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const blob = new Blob([buffer], { type: 'image/jpeg' });
      formData.append('files', blob, image.title || 'upload.jpg');
    }

    const url = this.buildUrl(`${this.apiPrefix}/upload`);
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: formData,
    });

    if (!response.ok) throw new Error(`Strapi media upload failed: ${response.status}`);

    const uploaded = await response.json() as StrapiMediaResponse[];
    return { id: uploaded[0].id, url: uploaded[0].url };
  }

  async getCategories(): Promise<CMSTaxonomyTerm[]> {
    this.ensureConnected();

    try {
      const result = await this.strapiApi<{ data: Array<{ id: number; attributes?: { name: string; slug: string } }> }>(
        `${this.apiPrefix}/categories?pagination[pageSize]=100`
      );
      return result.data.map((c) => ({
        id: c.id,
        name: c.attributes?.name || (c as Record<string, unknown>).name as string || '',
        slug: c.attributes?.slug || (c as Record<string, unknown>).slug as string || '',
      }));
    } catch {
      return [];
    }
  }

  async getTags(): Promise<CMSTaxonomyTerm[]> {
    this.ensureConnected();

    try {
      const result = await this.strapiApi<{ data: Array<{ id: number; attributes?: { name: string; slug: string } }> }>(
        `${this.apiPrefix}/tags?pagination[pageSize]=100`
      );
      return result.data.map((t) => ({
        id: t.id,
        name: t.attributes?.name || (t as Record<string, unknown>).name as string || '',
        slug: t.attributes?.slug || (t as Record<string, unknown>).slug as string || '',
      }));
    } catch {
      return [];
    }
  }

  // --- Private helpers ---

  protected getAuthHeaders(): Record<string, string> {
    if (this.credentials.api_token) {
      return { Authorization: `Bearer ${this.credentials.api_token}` };
    }
    if (this.credentials.jwt_token) {
      return { Authorization: `Bearer ${this.credentials.jwt_token}` };
    }
    return {};
  }

  private async strapiApi<T>(path: string, options: RequestInit = {}): Promise<T> {
    return this.apiRequest<T>(path, options);
  }

  private resolveContentType(content: PublishableContent): string {
    // Default to 'articles' — in production this would be configurable per publication
    return (content.custom_fields?.strapi_content_type as string) || 'articles';
  }

  private toStrapiData(content: PublishableContent): Record<string, unknown> {
    const data: Record<string, unknown> = {
      title: content.title,
      content: content.body,
      slug: content.slug,
    };

    if (content.excerpt) data.description = content.excerpt;
    if (content.categories?.length) data.categories = content.categories;
    if (content.tags?.length) data.tags = content.tags;

    // SEO component (common Strapi pattern)
    if (content.seo) {
      data.seo = {
        metaTitle: content.seo.meta_title,
        metaDescription: content.seo.meta_description,
        canonicalURL: content.seo.canonical_url,
        keywords: content.seo.focus_keyword,
        metaSocial: [
          {
            socialNetwork: 'Facebook',
            title: content.seo.og_title || content.seo.meta_title,
            description: content.seo.og_description || content.seo.meta_description,
            image: content.seo.og_image,
          },
          {
            socialNetwork: 'Twitter',
            title: content.seo.twitter_title || content.seo.og_title || content.seo.meta_title,
            description: content.seo.twitter_description || content.seo.og_description || content.seo.meta_description,
          },
        ],
      };
    }

    // Spread custom fields
    if (content.custom_fields) {
      const { strapi_content_type, ...rest } = content.custom_fields as Record<string, unknown>;
      Object.assign(data, rest);
    }

    return data;
  }

  private fromStrapiEntry(entry: StrapiEntry): PublishableContent {
    const attrs = entry.attributes || entry;

    return {
      title: attrs.title as string || '',
      body: attrs.content as string || '',
      body_format: 'html',
      slug: attrs.slug as string || '',
      excerpt: attrs.description as string,
      status: 'publish',
      seo: {
        meta_title: (attrs.seo as Record<string, unknown>)?.metaTitle as string || attrs.title as string || '',
        meta_description: (attrs.seo as Record<string, unknown>)?.metaDescription as string || '',
        slug: attrs.slug as string || '',
      },
    };
  }

  private mapStrapiFieldType(strapiType: string): CMSFieldDefinition['type'] {
    const mapping: Record<string, CMSFieldDefinition['type']> = {
      string: 'text',
      text: 'text',
      richtext: 'richtext',
      blocks: 'richtext',
      integer: 'number',
      float: 'number',
      decimal: 'number',
      boolean: 'boolean',
      media: 'media',
      relation: 'relation',
      json: 'json',
      datetime: 'datetime',
      date: 'datetime',
      time: 'datetime',
    };
    return mapping[strapiType] || 'text';
  }
}
