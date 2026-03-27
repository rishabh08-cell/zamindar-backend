import type {
  CMSAdapter,
  CMSAdapterConfig,
  CMSPlatform,
  CMSSchema,
  CMSTaxonomyTerm,
  PublishableContent,
  AgentPublishResult,
  ContentImage,
} from '../../../types';

export abstract class BaseCMSAdapter implements CMSAdapter {
  abstract readonly platform: CMSPlatform;

  protected siteUrl: string = '';
  protected credentials: Record<string, string> = {};
  protected connected: boolean = false;

  abstract connect(config: CMSAdapterConfig): Promise<{ success: boolean; site_name: string; error?: string }>;
  abstract testConnection(): Promise<boolean>;
  abstract fetchSchema(): Promise<CMSSchema>;
  abstract createPost(content: PublishableContent): Promise<AgentPublishResult>;
  abstract updatePost(cmsPostId: string, content: PublishableContent): Promise<AgentPublishResult>;
  abstract deletePost(cmsPostId: string): Promise<{ success: boolean; error?: string }>;
  abstract getPost(cmsPostId: string): Promise<PublishableContent | null>;
  abstract uploadMedia(image: ContentImage, fileBuffer?: Buffer): Promise<{ id: string | number; url: string }>;
  abstract getCategories(): Promise<CMSTaxonomyTerm[]>;
  abstract getTags(): Promise<CMSTaxonomyTerm[]>;

  protected ensureConnected(): void {
    if (!this.connected) {
      throw new Error(`${this.platform} adapter is not connected. Call connect() first.`);
    }
  }

  protected buildUrl(path: string): string {
    const base = this.siteUrl.replace(/\/+$/, '');
    const cleanPath = path.replace(/^\/+/, '');
    return `${base}/${cleanPath}`;
  }

  protected async apiRequest<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    this.ensureConnected();

    const url = this.buildUrl(path);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
      ...(options.headers as Record<string, string> || {}),
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new Error(`${this.platform} API error (${response.status}): ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  protected abstract getAuthHeaders(): Record<string, string>;
}
