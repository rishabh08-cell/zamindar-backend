import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import type {
  ParsedContent,
  PublishableContent,
  CMSSchema,
  MissingField,
  AgentValidationResult,
  SEOFields,
} from '../../types';

const DEFAULT_PLAYBOOK_PATH = path.resolve(__dirname, '../../../seo-playbook.md');

export class PublishingAgent {
  private client: Anthropic;
  private playbook: string;

  constructor(playbookPath?: string) {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
    this.playbook = this.loadPlaybook(playbookPath || DEFAULT_PLAYBOOK_PATH);
  }

  /**
   * Main entry point: takes parsed content + target CMS schema,
   * returns validated + enriched content ready to publish.
   */
  async prepare(
    content: ParsedContent,
    cmsSchema: CMSSchema | null,
    userInstructions?: string
  ): Promise<AgentValidationResult> {
    const systemPrompt = this.buildSystemPrompt(cmsSchema);
    const userPrompt = this.buildUserPrompt(content, userInstructions);

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return this.parseAgentResponse(text, content);
  }

  /**
   * Ask the agent to fill specific missing fields based on the content.
   */
  async autoFill(
    content: ParsedContent,
    missingFields: MissingField[]
  ): Promise<Record<string, { value: unknown; reason: string }>> {
    const fillable = missingFields.filter((f) => f.auto_fillable);
    if (fillable.length === 0) return {};

    const prompt = `Given this content, generate values for the following missing fields.
Return JSON with field names as keys and objects with "value" and "reason".

Content title: ${content.title}
Content (first 2000 chars): ${content.raw_text.slice(0, 2000)}
Word count: ${content.word_count}

Missing fields to fill:
${fillable.map((f) => `- ${f.field}: ${f.label} (${f.reason})`).join('\n')}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: this.playbook,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const result = this.extractJson(text) as Record<string, { value: unknown; reason: string }> | null;
    return result || {};
  }

  /**
   * Audit existing published content and suggest improvements.
   */
  async audit(
    content: PublishableContent
  ): Promise<{ score: number; issues: string[]; suggestions: string[] }> {
    const prompt = `Audit this published content for SEO quality. Return JSON with:
- score (0-100)
- issues (array of problems found)
- suggestions (array of improvement recommendations)

Title: ${content.title}
Slug: ${content.slug}
Meta Title: ${content.seo.meta_title}
Meta Description: ${content.seo.meta_description}
Body (first 3000 chars): ${content.body.slice(0, 3000)}
Word count: ${content.body.replace(/<[^>]*>/g, '').split(/\s+/).length}
Has featured image: ${!!content.featured_image}
Categories: ${content.categories?.join(', ') || 'none'}
Tags: ${content.tags?.join(', ') || 'none'}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: this.playbook,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const parsed = this.extractJson(text) as { score: number; issues: string[]; suggestions: string[] } | null;
    return parsed || { score: 0, issues: ['Failed to parse audit'], suggestions: [] };
  }

  // --- Private ---

  private loadPlaybook(playbookPath: string): string {
    try {
      return fs.readFileSync(playbookPath, 'utf-8');
    } catch {
      return `You are an expert SEO manager. Follow best practices for meta titles (max 60 chars),
meta descriptions (150-160 chars), slugs (short, keyword-rich, hyphenated),
Open Graph tags, and content quality. Always identify and flag missing required fields.`;
    }
  }

  private buildSystemPrompt(cmsSchema: CMSSchema | null): string {
    let prompt = `${this.playbook}

---

You are a publishing agent. Your job is to take raw content and prepare it for CMS publishing.
You MUST return valid JSON (no markdown fences, just raw JSON).

Return a JSON object with this structure:
{
  "publishable_content": {
    "title": "string",
    "body": "string (HTML)",
    "body_format": "html",
    "slug": "string",
    "excerpt": "string",
    "status": "draft",
    "seo": {
      "meta_title": "string (max 60 chars)",
      "meta_description": "string (150-160 chars)",
      "slug": "string",
      "canonical_url": "string or null",
      "focus_keyword": "string",
      "og_title": "string",
      "og_description": "string (max 200 chars)",
      "og_image": "string or null",
      "twitter_card": "summary_large_image",
      "twitter_title": "string",
      "twitter_description": "string"
    },
    "categories": [],
    "tags": []
  },
  "missing": [
    {
      "field": "string",
      "label": "string",
      "reason": "string",
      "severity": "required | recommended",
      "suggestions": ["string"],
      "auto_fillable": true/false
    }
  ],
  "warnings": ["string"],
  "auto_filled": {
    "field_name": { "value": "...", "reason": "..." }
  }
}`;

    if (cmsSchema) {
      prompt += `\n\nTarget CMS Schema:
Content Types: ${JSON.stringify(cmsSchema.content_types, null, 2)}
Available Categories: ${JSON.stringify(cmsSchema.categories.slice(0, 50))}
Available Tags: ${JSON.stringify(cmsSchema.tags.slice(0, 50))}
Custom Fields: ${JSON.stringify(cmsSchema.custom_fields)}`;
    }

    return prompt;
  }

  private buildUserPrompt(content: ParsedContent, userInstructions?: string): string {
    let prompt = `Prepare this content for publishing:

Title: ${content.title}
Word Count: ${content.word_count}
Headings: ${content.headings.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n')}
Images found: ${content.images.length}
${content.images.map((img, i) => `  Image ${i + 1}: ${img.alt || 'no alt text'} — ${img.url?.slice(0, 80)}`).join('\n')}

Content (HTML):
${content.body_html.slice(0, 8000)}

${content.body_html.length > 8000 ? `... (truncated, full content is ${content.body_html.length} chars)` : ''}`;

    if (userInstructions) {
      prompt += `\n\nUser instructions: ${userInstructions}`;
    }

    return prompt;
  }

  private parseAgentResponse(text: string, originalContent: ParsedContent): AgentValidationResult {
    const parsed = this.extractJson(text);

    if (!parsed?.publishable_content) {
      return {
        is_ready: false,
        content: this.fallbackContent(originalContent),
        missing: [{
          field: 'agent_response',
          label: 'Agent Response',
          reason: 'Failed to parse agent output — manual review needed',
          severity: 'required',
          suggestions: [],
          auto_fillable: false,
        }],
        warnings: ['Agent response could not be parsed. Using fallback content.'],
        auto_filled: {},
      };
    }

    const missing: MissingField[] = (parsed.missing as MissingField[]) || [];
    const hasRequiredMissing = missing.some((m: MissingField) => m.severity === 'required');

    return {
      is_ready: !hasRequiredMissing,
      content: parsed.publishable_content as PublishableContent,
      missing,
      warnings: (parsed.warnings as string[]) || [],
      auto_filled: (parsed.auto_filled as Record<string, { value: unknown; reason: string }>) || {},
    };
  }

  private fallbackContent(content: ParsedContent): PublishableContent {
    const slug = content.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60);

    const seo: SEOFields = {
      meta_title: content.title.slice(0, 60),
      meta_description: content.raw_text.slice(0, 160).trim(),
      slug,
    };

    return {
      title: content.title,
      body: content.body_html,
      body_format: 'html',
      slug,
      excerpt: content.raw_text.slice(0, 300).trim(),
      status: 'draft',
      seo,
      featured_image: content.images.find((img) => img.is_featured) || content.images[0],
    };
  }

  private extractJson(text: string): Record<string, unknown> | null {
    try {
      // Try direct parse
      return JSON.parse(text);
    } catch {
      // Try extracting JSON from markdown code blocks
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try {
          return JSON.parse(match[1].trim());
        } catch {
          // fall through
        }
      }

      // Try finding first { to last }
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch {
          return null;
        }
      }

      return null;
    }
  }
}
