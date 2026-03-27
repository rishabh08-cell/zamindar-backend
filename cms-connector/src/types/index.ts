// ============================================================
// Core domain types for the CMS Connector
// ============================================================

// --- CMS Platforms ---

export type CMSPlatform = 'wordpress' | 'strapi';

export interface CMSConnection {
  id: string;
  user_id: string;
  platform: CMSPlatform;
  site_url: string;
  site_name: string;
  credentials_encrypted: string;
  schema_cache: CMSSchema | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CMSSchema {
  content_types: CMSContentType[];
  categories: CMSTaxonomyTerm[];
  tags: CMSTaxonomyTerm[];
  custom_fields: CMSCustomField[];
  fetched_at: string;
}

export interface CMSContentType {
  slug: string;
  name: string;
  fields: CMSFieldDefinition[];
}

export interface CMSFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'richtext' | 'number' | 'boolean' | 'media' | 'relation' | 'json' | 'datetime';
  required: boolean;
  default?: unknown;
}

export interface CMSTaxonomyTerm {
  id: string | number;
  name: string;
  slug: string;
  parent_id?: string | number | null;
}

export interface CMSCustomField {
  key: string;
  label: string;
  type: string;
  platform_meta?: Record<string, unknown>; // ACF group info, Strapi component name, etc.
}

// --- Content Sources ---

export type ContentSourceType = 'google_doc' | 'google_sheet' | 'pepper_doc';

export interface ContentSource {
  id: string;
  user_id: string;
  source_type: ContentSourceType;
  source_ref: string; // doc URL, sheet URL, pepper doc ID
  title: string;
  last_fetched_at: string | null;
  created_at: string;
}

export interface ParsedContent {
  title: string;
  body_html: string;
  body_markdown?: string;
  excerpt?: string;
  images: ContentImage[];
  headings: ContentHeading[];
  raw_text: string;
  word_count: number;
  source: {
    type: ContentSourceType;
    ref: string;
  };
}

export interface ContentImage {
  url: string;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
  is_featured?: boolean;
}

export interface ContentHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

// --- SEO & Meta ---

export interface SEOFields {
  meta_title: string;
  meta_description: string;
  canonical_url?: string;
  slug: string;
  focus_keyword?: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  twitter_card?: 'summary' | 'summary_large_image';
  twitter_title?: string;
  twitter_description?: string;
  structured_data?: Record<string, unknown>;
}

// --- Publishing ---

export type PublicationStatus = 'draft' | 'pending_review' | 'needs_input' | 'publishing' | 'published' | 'failed' | 'update_available';

export interface Publication {
  id: string;
  user_id: string;
  content_source_id: string | null;
  cms_connection_id: string;
  cms_post_id: string | null;
  cms_post_url: string | null;
  status: PublicationStatus;
  content_snapshot: PublishableContent;
  field_mapping: Record<string, string>;
  missing_fields: MissingField[];
  error_message: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublishableContent {
  title: string;
  body: string;
  body_format: 'html' | 'markdown';
  slug: string;
  excerpt?: string;
  status: 'draft' | 'publish';
  categories?: (string | number)[];
  tags?: (string | number)[];
  featured_image?: ContentImage;
  seo: SEOFields;
  custom_fields?: Record<string, unknown>;
}

export interface MissingField {
  field: string;
  label: string;
  reason: string;
  severity: 'required' | 'recommended';
  suggestions?: string[];
  auto_fillable: boolean;
}

// --- Agent ---

export interface AgentValidationResult {
  is_ready: boolean;
  content: PublishableContent;
  missing: MissingField[];
  warnings: string[];
  auto_filled: Record<string, { value: unknown; reason: string }>;
}

export interface AgentPublishResult {
  success: boolean;
  cms_post_id?: string;
  cms_post_url?: string;
  error?: string;
  details?: Record<string, unknown>;
}

// --- CMS Adapter Interface ---

export interface CMSAdapterConfig {
  site_url: string;
  credentials: Record<string, string>;
}

export interface CMSAdapter {
  readonly platform: CMSPlatform;

  connect(config: CMSAdapterConfig): Promise<{ success: boolean; site_name: string; error?: string }>;
  testConnection(): Promise<boolean>;
  fetchSchema(): Promise<CMSSchema>;

  createPost(content: PublishableContent): Promise<AgentPublishResult>;
  updatePost(cmsPostId: string, content: PublishableContent): Promise<AgentPublishResult>;
  deletePost(cmsPostId: string): Promise<{ success: boolean; error?: string }>;
  getPost(cmsPostId: string): Promise<PublishableContent | null>;

  uploadMedia(image: ContentImage, fileBuffer?: Buffer): Promise<{ id: string | number; url: string }>;
  getCategories(): Promise<CMSTaxonomyTerm[]>;
  getTags(): Promise<CMSTaxonomyTerm[]>;
}

// --- API Request/Response ---

export interface ConnectCMSRequest {
  platform: CMSPlatform;
  site_url: string;
  credentials: Record<string, string>;
}

export interface PublishRequest {
  content_source_id?: string;
  cms_connection_ids: string[];
  content?: Partial<PublishableContent>;
  auto_fill?: boolean;
  publish_status?: 'draft' | 'publish';
}

export interface SyncRequest {
  publication_id: string;
  fields?: Partial<PublishableContent>;
  resolve_missing?: Record<string, unknown>;
}
