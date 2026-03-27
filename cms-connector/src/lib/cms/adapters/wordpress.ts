import { BaseCMSAdapter } from './base';
import type {
  CMSAdapterConfig,
  CMSPlatform,
  CMSSchema,
  CMSTaxonomyTerm,
  CMSContentType,
  CMSCustomField,
  PublishableContent,
  AgentPublishResult,
  ContentImage,
} from '../../../types';

interface WPPost {
  id: number;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  slug: string;
  status: string;
  categories: number[];
  tags: number[];
  featured_media: number;
  meta: Record<string, unknown>;
  yoast_head_json?: Record<string, unknown>;
}

interface WPTerm {
  id: number;
  name: string;
  slug: string;
  parent: number;
}

interface WPMediaResponse {
  id: number;
  source_url: string;
}

export class WordPressAdapter extends BaseCMSAdapter {
  readonly platform: CMSPlatform = 'wordpress';

  async connect(config: CMSAdapterConfig): Promise<{ success: boolean; site_name: string; error?: string }> {
    this.siteUrl = config.site_url.replace(/\/+$/, '');
    this.credentials = config.credentials;

    try {
      const siteInfo = await this.wpApi<{ name: string; url: string }>('/wp-json');
      this.connected = true;
      return { success: true, site_name: siteInfo.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      return { success: false, site_name: '', error: message };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.wpApi<{ id: number }>('/wp-json/wp/v2/users/me');
      return true;
    } catch {
      return false;
    }
  }

  async fetchSchema(): Promise<CMSSchema> {
    this.ensureConnected();

    const [categories, tags] = await Promise.all([
      this.getCategories(),
      this.getTags(),
    ]);

    const postType: CMSContentType = {
      slug: 'post',
      name: 'Post',
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'content', label: 'Content', type: 'richtext', required: true },
        { key: 'excerpt', label: 'Excerpt', type: 'text', required: false },
        { key: 'slug', label: 'Slug', type: 'text', required: false },
        { key: 'status', label: 'Status', type: 'text', required: false, default: 'draft' },
        { key: 'featured_media', label: 'Featured Image', type: 'media', required: false },
      ],
    };

    const pageType: CMSContentType = {
      slug: 'page',
      name: 'Page',
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'content', label: 'Content', type: 'richtext', required: true },
        { key: 'slug', label: 'Slug', type: 'text', required: false },
        { key: 'status', label: 'Status', type: 'text', required: false, default: 'draft' },
      ],
    };

    // Attempt to fetch ACF fields if ACF is active
    const customFields = await this.fetchACFFields();

    return {
      content_types: [postType, pageType],
      categories,
      tags,
      custom_fields: customFields,
      fetched_at: new Date().toISOString(),
    };
  }

  async createPost(content: PublishableContent): Promise<AgentPublishResult> {
    this.ensureConnected();

    try {
      let featuredMediaId: number | undefined;
      if (content.featured_image?.url) {
        const media = await this.uploadMedia(content.featured_image);
        featuredMediaId = media.id as number;
      }

      const postData = this.toWPPostData(content, featuredMediaId);
      const post = await this.wpApi<WPPost>('/wp-json/wp/v2/posts', {
        method: 'POST',
        body: JSON.stringify(postData),
      });

      // Set SEO meta if Yoast/RankMath is available
      await this.setSEOMeta(post.id, content.seo).catch(() => {});

      return {
        success: true,
        cms_post_id: String(post.id),
        cms_post_url: post.link,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create post',
      };
    }
  }

  async updatePost(cmsPostId: string, content: PublishableContent): Promise<AgentPublishResult> {
    this.ensureConnected();

    try {
      let featuredMediaId: number | undefined;
      if (content.featured_image?.url) {
        const media = await this.uploadMedia(content.featured_image);
        featuredMediaId = media.id as number;
      }

      const postData = this.toWPPostData(content, featuredMediaId);
      const post = await this.wpApi<WPPost>(`/wp-json/wp/v2/posts/${cmsPostId}`, {
        method: 'PUT',
        body: JSON.stringify(postData),
      });

      await this.setSEOMeta(post.id, content.seo).catch(() => {});

      return {
        success: true,
        cms_post_id: String(post.id),
        cms_post_url: post.link,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to update post',
      };
    }
  }

  async deletePost(cmsPostId: string): Promise<{ success: boolean; error?: string }> {
    this.ensureConnected();

    try {
      await this.wpApi(`/wp-json/wp/v2/posts/${cmsPostId}`, {
        method: 'DELETE',
        body: JSON.stringify({ force: true }),
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to delete post' };
    }
  }

  async getPost(cmsPostId: string): Promise<PublishableContent | null> {
    this.ensureConnected();

    try {
      const post = await this.wpApi<WPPost>(`/wp-json/wp/v2/posts/${cmsPostId}`);
      return this.fromWPPost(post);
    } catch {
      return null;
    }
  }

  async uploadMedia(image: ContentImage, fileBuffer?: Buffer): Promise<{ id: number; url: string }> {
    this.ensureConnected();

    if (fileBuffer) {
      const filename = image.title || 'upload.jpg';
      const url = this.buildUrl('/wp-json/wp/v2/media');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getAuthHeaders(),
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Type': 'image/jpeg',
        },
        body: fileBuffer,
      });

      if (!response.ok) throw new Error(`Media upload failed: ${response.status}`);
      const media = await response.json() as WPMediaResponse;
      return { id: media.id, url: media.source_url };
    }

    // If only URL provided, sideload via WordPress URL import
    const media = await this.wpApi<WPMediaResponse>('/wp-json/wp/v2/media', {
      method: 'POST',
      body: JSON.stringify({
        source_url: image.url,
        alt_text: image.alt || '',
        title: image.title || '',
      }),
    });

    return { id: media.id, url: media.source_url };
  }

  async getCategories(): Promise<CMSTaxonomyTerm[]> {
    this.ensureConnected();

    const terms = await this.wpApi<WPTerm[]>('/wp-json/wp/v2/categories?per_page=100');
    return terms.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      parent_id: t.parent || null,
    }));
  }

  async getTags(): Promise<CMSTaxonomyTerm[]> {
    this.ensureConnected();

    const terms = await this.wpApi<WPTerm[]>('/wp-json/wp/v2/tags?per_page=100');
    return terms.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
    }));
  }

  // --- Private helpers ---

  protected getAuthHeaders(): Record<string, string> {
    const { username, application_password } = this.credentials;
    if (username && application_password) {
      const encoded = Buffer.from(`${username}:${application_password}`).toString('base64');
      return { Authorization: `Basic ${encoded}` };
    }
    if (this.credentials.jwt_token) {
      return { Authorization: `Bearer ${this.credentials.jwt_token}` };
    }
    return {};
  }

  private async wpApi<T>(path: string, options: RequestInit = {}): Promise<T> {
    return this.apiRequest<T>(path, options);
  }

  private toWPPostData(content: PublishableContent, featuredMediaId?: number): Record<string, unknown> {
    const data: Record<string, unknown> = {
      title: content.title,
      content: content.body,
      slug: content.slug,
      status: content.status === 'publish' ? 'publish' : 'draft',
    };

    if (content.excerpt) data.excerpt = content.excerpt;
    if (content.categories?.length) data.categories = content.categories;
    if (content.tags?.length) data.tags = content.tags;
    if (featuredMediaId) data.featured_media = featuredMediaId;
    if (content.custom_fields) data.meta = content.custom_fields;

    return data;
  }

  private fromWPPost(post: WPPost): PublishableContent {
    return {
      title: post.title.rendered,
      body: post.content.rendered,
      body_format: 'html',
      slug: post.slug,
      excerpt: post.excerpt.rendered,
      status: post.status === 'publish' ? 'publish' : 'draft',
      categories: post.categories,
      tags: post.tags,
      seo: {
        meta_title: post.yoast_head_json?.title as string || post.title.rendered,
        meta_description: post.yoast_head_json?.description as string || '',
        slug: post.slug,
        og_title: post.yoast_head_json?.og_title as string,
        og_description: post.yoast_head_json?.og_description as string,
        og_image: (post.yoast_head_json?.og_image as Array<{ url: string }>)?.[0]?.url,
      },
    };
  }

  private async setSEOMeta(postId: number, seo: PublishableContent['seo']): Promise<void> {
    // Try Yoast REST API
    await this.wpApi(`/wp-json/yoast/v1/posts/${postId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        yoast_wpseo_title: seo.meta_title,
        yoast_wpseo_metadesc: seo.meta_description,
        yoast_wpseo_focuskw: seo.focus_keyword || '',
        yoast_wpseo_canonical: seo.canonical_url || '',
      }),
    });
  }

  private async fetchACFFields(): Promise<CMSCustomField[]> {
    try {
      const groups = await this.wpApi<Array<{ title: { rendered: string }; acf: Record<string, unknown> }>>(
        '/wp-json/acf/v3/field-groups'
      );
      return groups.map((g) => ({
        key: g.title.rendered.toLowerCase().replace(/\s+/g, '_'),
        label: g.title.rendered,
        type: 'json',
        platform_meta: { acf: true },
      }));
    } catch {
      return [];
    }
  }
}
