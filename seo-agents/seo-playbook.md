# SEO Agent Playbook

This document is the operating manual for an autonomous SEO agent. Every decision — from keyword selection to publish-time metadata — should be traceable back to a rule in this playbook. When in doubt, follow the hierarchy: **User overrides → This playbook → Industry best practice**.

---

## 1. Keyword Research & Topic Discovery

### 1.1 Seed Keyword Expansion

- Start from the user-provided seed keyword or topic.
- Generate semantic variations: synonyms, long-tail phrases, question-based queries ("how to…", "what is…", "best…for…").
- Group keywords by search intent: informational, navigational, transactional, commercial investigation.
- Prioritize keywords by: search volume → keyword difficulty → business relevance (in that order, unless the user specifies otherwise).

### 1.2 Topic Clustering

- Every piece of content belongs to exactly one topic cluster.
- A cluster has one pillar page (broad, high-volume keyword) and multiple cluster pages (specific, long-tail keywords).
- Before creating new content, check:
  1. Does a cluster for this topic already exist?
  2. If yes → create a cluster page and link it to the pillar.
  3. If no → propose a new cluster with at least 5 planned sub-topics before writing the first piece.

### 1.3 Competitive Gap Analysis

- For every target keyword, identify the top 5 ranking pages.
- Note: content format (listicle, guide, comparison, tool), word count, heading structure, and unique angles.
- The new content must offer at least one differentiator: deeper coverage, fresher data, better structure, or a unique angle not present in top results.

### 1.4 Cannibalization Check

- Before assigning a primary keyword to new content, search the existing CMS for pages already targeting the same keyword.
- If a match is found:
  - **Same intent** → Update the existing page instead of creating a new one.
  - **Different intent** → Proceed, but ensure distinct slugs, titles, and internal linking to signal the difference to crawlers.

---

## 2. Content Planning & Brief

### 2.1 Content Brief Structure

Every piece of content should have a brief generated before writing begins. The brief includes:

| Field | Requirement |
|-------|-------------|
| Primary keyword | One keyword, exact match |
| Secondary keywords | 3–5 related terms to weave in naturally |
| Search intent | Informational / Transactional / Navigational / Commercial |
| Target word count | Based on top-ranking competitor average ± 20% |
| Content format | Guide, listicle, comparison, how-to, opinion, case study |
| Target audience | Specific persona or segment |
| Unique angle | What makes this piece different from what already ranks |
| Internal link targets | 3–5 existing pages to link to/from |
| CTA | What the reader should do after reading |

### 2.2 Content Calendar Logic

- Never publish more than one piece targeting keywords within the same cluster in the same week (prevents self-competition during indexing).
- Evergreen content takes priority over time-sensitive content unless the user overrides.
- Schedule updates for existing high-performing content every 90 days.

---

## 3. Writing Guidelines

### 3.1 Heading Structure

- **H1**: Exactly one per page. Must contain the primary keyword. Should not be identical to the meta title.
- **H2s**: Use for major sections. Include secondary keywords where natural.
- **H3s–H4s**: Use for sub-sections. Do not skip levels (no H2 → H4).
- Every H2 section should be independently valuable — a reader skimming headings should understand the full scope of the article.

### 3.2 Keyword Placement

- Primary keyword must appear in: H1, first 100 words, at least one H2, meta title, meta description, slug.
- Secondary keywords: distribute across H2s and body text. Do not force — if it reads unnaturally, drop it.
- Keyword density: Do not target a specific percentage. Focus on natural language. If a keyword appears more than 3× per 500 words, it's likely overstuffed.

### 3.3 Readability

- Target a Flesch-Kincaid grade level of 8–10 (general audience) unless the brief specifies a technical audience.
- Paragraphs: max 3–4 sentences.
- Use transition words between sections.
- Avoid passive voice where active voice is clearer.

### 3.4 Media & Visual Content

- At least one image per 500 words of content.
- Every image must have:
  - Descriptive alt text (include keyword only if it naturally describes the image).
  - A compressed file size (< 200KB for standard images, < 500KB for infographics).
  - Descriptive filename (e.g., `seo-keyword-research-process.png`, not `IMG_4032.png`).
- Prefer original images, diagrams, or screenshots over stock photos.

---

## 4. On-Page SEO & Metadata

### 4.1 Meta Title

- Max 60 characters (Google truncates at ~580px, roughly 60 chars).
- Format: `{Primary Keyword} - {Secondary Context} | {Brand}`
- Never start with the brand name.
- Must contain the primary keyword from the content.
- Front-load the most important words.

### 4.2 Meta Description

- 150–160 characters.
- Must include a CTA or value proposition (e.g., "Learn how…", "Discover…", "Get the complete guide…").
- Include primary keyword naturally — it will be bolded in SERPs.
- Must NOT duplicate the meta title.

### 4.3 URL / Slug

- Lowercase, hyphenated.
- Max 4–5 words.
- Remove stop words: the, a, an, in, on, of, for, to, with, is, at, by, from.
- Must contain the primary keyword.
- Never change a published slug unless setting up a 301 redirect from the old URL.

### 4.4 Open Graph & Social Meta

- **og:title** — Can differ from the meta title. Optimize for clicks/shareability on social.
- **og:description** — Conversational tone, max 200 characters.
- **og:image** — Must be set. Minimum 1200×630px. Use a unique image per page when possible.
- **og:type** — `article` for blog posts, `website` for landing pages.
- **twitter:card** — Always `summary_large_image`.
- **twitter:title** and **twitter:description** — Can mirror OG or be customized for Twitter's audience.

### 4.5 Canonical Tags

- Every page must have a self-referencing canonical tag.
- If content is syndicated or duplicated, the canonical must point to the original source.
- Never set a canonical to a page that itself has a different canonical (canonical chains).

---

## 5. Schema / Structured Data

### 5.1 Required Schema by Content Type

| Content Type | Schema Type | Required Fields |
|-------------|-------------|-----------------|
| Blog post / Article | `Article` or `BlogPosting` | headline, author, datePublished, dateModified, image, publisher |
| How-to guide | `HowTo` | name, step[].text, step[].name, totalTime (if applicable) |
| FAQ section | `FAQPage` | mainEntity[].name (question), mainEntity[].acceptedAnswer.text |
| Product page | `Product` | name, description, image, offers.price, offers.priceCurrency |
| Listicle / Roundup | `ItemList` | itemListElement[].name, itemListElement[].position |
| Organization page | `Organization` | name, url, logo, contactPoint |

### 5.2 Schema Rules

- Use JSON-LD format (not Microdata or RDFa).
- Place the `<script type="application/ld+json">` block in the `<head>` or at the end of `<body>`.
- Every Article/BlogPosting must include `dateModified` — update it whenever the content is revised.
- Validate all schema using Google's Rich Results Test before publishing.
- Do NOT add schema types that don't match the actual page content (e.g., no FAQPage schema if there's no FAQ section on the page).

### 5.3 Breadcrumb Schema

- Add `BreadcrumbList` schema to all pages deeper than the homepage.
- Structure: Home > Category > Subcategory > Page Title.
- The final breadcrumb item should NOT be a link (it's the current page).

---

## 6. Internal & External Linking

### 6.1 Internal Linking Rules

- Every new page must link to at least 3 existing pages on the site.
- Every new page should be linked from at least 2 existing, relevant pages (update those pages at publish time).
- Link from high-authority pages to new content to pass link equity.
- Use descriptive anchor text — never "click here" or "read more". The anchor should describe the target page.
- Anchor text variety: Don't use the exact same anchor text for all links pointing to one page. Mix exact-match, partial-match, and natural phrases.
- Pillar pages should link to all their cluster pages, and each cluster page should link back to its pillar.

### 6.2 External Linking Rules

- Link to authoritative, primary sources when citing data, statistics, or claims.
- Max 2–3 external links per 1,000 words (avoid link-heavy pages that bleed equity).
- Never link to direct competitors' content unless required for a comparison/review.
- All external links: `target="_blank"` and `rel="noopener"`.
- Do NOT add `rel="nofollow"` to editorial external links (use nofollow only for sponsored, UGC, or untrusted links).

### 6.3 Broken Link Prevention

- Before publishing, validate all internal and external links resolve to a 200 status.
- Flag any links to pages returning 301, 404, or 5xx.
- Suggest replacements for broken external links.

---

## 7. Categories, Tags & Taxonomy

### 7.1 Categories

- Max 1 primary category per post.
- Categories should map to your topic clusters / pillar pages.
- Never create a category with fewer than 3 planned pieces of content.
- Category names should be keyword-rich but natural (e.g., "Content Marketing" not "content-marketing-tips-and-strategies").

### 7.2 Tags

- Max 5 tags per post.
- Tags should be specific, not generic (e.g., "Google Core Update March 2026" not "SEO").
- Always suggest from the existing CMS taxonomy first before creating new tags.
- If a proposed tag has fewer than 2 existing posts, reconsider — orphan tag pages are bad for crawl budget.

---

## 8. Content Audit (Pre-Publish Checklist)

Run this checklist before every publish action. All items must pass.

### 8.1 Structure & Content

- [ ] H1 exists and contains the primary keyword
- [ ] Heading hierarchy is correct (no skipped levels)
- [ ] Word count meets the minimum from the brief (absolute minimum: 300 words)
- [ ] Content matches the declared search intent
- [ ] No duplicate content (check against existing pages)

### 8.2 Media

- [ ] At least one image with descriptive alt text
- [ ] All images are compressed and use descriptive filenames
- [ ] No missing/broken image references

### 8.3 Links

- [ ] No broken internal or external links
- [ ] At least 3 internal links present (suggest if missing)
- [ ] External links open in new tab with proper rel attributes

### 8.4 Metadata

- [ ] Meta title is set and within 60 characters
- [ ] Meta description is set and within 150–160 characters
- [ ] Slug follows rules (lowercase, hyphenated, keyword-present, no stop words)
- [ ] Canonical tag is present and correct
- [ ] OG tags are complete (title, description, image)

### 8.5 Technical

- [ ] Schema markup is present and valid for the content type
- [ ] Page loads in under 3 seconds (flag if CMS preview is slow)
- [ ] Mobile-friendly (no horizontal scroll, readable font sizes)
- [ ] No `noindex` tag present (unless intentionally unlisted)

---

## 9. Content Updates & Refresh Strategy

### 9.1 When to Refresh Content

Trigger a content refresh when any of the following are true:

- The page has dropped 5+ positions for its primary keyword over 30 days.
- The content is older than 6 months and contains time-sensitive information (stats, dates, tool versions).
- A competitor has published a significantly better piece on the same topic.
- The page gets traffic but has a high bounce rate (>70%) or low time on page (<1 min).
- User or team flags the content as outdated.

### 9.2 Refresh Process

1. Update `dateModified` in schema and CMS.
2. Revise the H1 and meta title only if the primary keyword strategy has changed.
3. Add new sections, update outdated stats, remove dead links.
4. Refresh internal links — link to any newer relevant content published since the original.
5. Do NOT change the slug unless absolutely necessary (and set a 301 redirect if you do).
6. Re-submit the URL to Google Search Console for re-indexing.

### 9.3 Cannibalization Resolution

When two pages compete for the same keyword:

- **Option A — Merge**: Combine both pages into one. 301 redirect the weaker URL to the stronger one. Consolidate backlinks.
- **Option B — Differentiate**: Rewrite one page to target a different (but related) keyword. Update its title, H1, and meta to clearly distinguish intent.
- **Option C — De-index**: If one page has no unique value, add `noindex` or remove it entirely with a 301 redirect.

### 9.4 Redirect Rules

- Always use 301 redirects for permanent URL changes (not 302).
- Never chain redirects (A → B → C). Point directly to the final destination.
- Maintain a redirect map/log for auditing.
- After setting a redirect, update all internal links to point to the new URL directly (don't rely on the redirect for internal traffic).

---

## 10. Platform-Specific Modules

This playbook is CMS-agnostic. The rules above apply universally. The modules below provide mapping guidance for specific platforms. Apply the relevant module based on the user's CMS.

### 10.1 WordPress

- **SEO Plugin Fields (Yoast / RankMath)**:
  - Set the focus keyword to the primary keyword from the brief.
  - Mark pillar pages as "Cornerstone content" in Yoast or "Pillar Content" in RankMath.
  - Use the plugin's SEO analysis as a secondary check — this playbook's rules take precedence on conflicts.
- **Excerpt vs. Meta Description**: Write these separately. The excerpt appears in RSS feeds and archive pages; the meta description is for SERPs. They should complement, not duplicate.
- **Categories & Tags**: Use WordPress's native taxonomy. Do not create custom taxonomies for SEO purposes unless the theme/architecture requires it.
- **Permalinks**: Ensure the permalink structure is set to `/%postname%/` or `/%category%/%postname%/`. Never use date-based or ID-based permalinks.

### 10.2 Strapi (Headless CMS)

- **SEO Component**: Create a reusable SEO component with fields for: metaTitle, metaDescription, canonicalUrl, ogTitle, ogDescription, ogImage, structuredData (JSON field).
- **Field Mapping**: Map every field in Section 4 (Metadata) to an explicit field in the SEO component — do not rely on auto-generation.
- **Rich Text → Markdown**: When content is authored in Strapi's rich text editor and rendered on a static frontend, ensure the conversion preserves heading hierarchy, alt text, and link attributes.
- **Preview/Draft**: Use Strapi's draft system. Run the pre-publish checklist (Section 8) against the draft before flipping to "published."

### 10.3 Webflow

- **SEO Settings**: Use Webflow's built-in SEO fields on each page/collection item: Title Tag, Meta Description, OG Image, Slug.
- **Collection Pages**: For blog posts, use CMS Collections. Bind SEO fields to collection fields so they auto-populate but can be overridden.
- **301 Redirects**: Manage in Project Settings → Hosting → 301 Redirects.
- **Sitemap**: Webflow auto-generates a sitemap. Ensure excluded pages (e.g., thank-you pages, test pages) are toggled off in page settings.

### 10.4 Shopify

- **Product Pages**: Map meta title to product title + modifier (e.g., "Buy {Product} Online | {Brand}"). Use the meta description field for unique copy — do not auto-generate from product descriptions.
- **Collection Pages**: Treat collection pages as pseudo-pillar pages. Optimize their meta and add introductory text above the product grid.
- **Blog**: Shopify's blog engine is limited. Ensure tags are used consistently and match your taxonomy plan.
- **Apps**: If using an SEO app (e.g., SEO Manager, Smart SEO), configure it to follow this playbook's rules — do not rely on its defaults.

### 10.5 Custom / Headless (Next.js, Gatsby, Astro, etc.)

- **Meta Tags**: Use the framework's `<Head>` component (or equivalent) to set all meta, OG, and canonical tags.
- **SSR / SSG**: Ensure all SEO-critical content is server-rendered or statically generated — not loaded client-side via JavaScript.
- **Sitemap**: Generate programmatically (e.g., `next-sitemap`, `gatsby-plugin-sitemap`). Ensure it updates on every new publish.
- **Structured Data**: Inject JSON-LD in the page template based on content type (use the mapping in Section 5).
- **Robots.txt**: Maintain a `robots.txt` that allows crawling of all public pages and blocks admin/API routes.

---

## 11. Decision Trees

### 11.1 "Should I create new content or update existing?"

```
Is there an existing page targeting this keyword?
├── No → Create new content. Assign to a cluster.
└── Yes → Does the existing page rank in the top 20?
    ├── Yes → Update it (Section 9.2). Don't create a new page.
    └── No → Is the existing page older than 12 months with no backlinks?
        ├── Yes → Rewrite it completely (same URL). Treat as a refresh.
        └── No → Check if the intent has shifted.
            ├── Same intent → Update the existing page.
            └── Different intent → Create new content. Differentiate clearly.
```

### 11.2 "How should I handle this slug change?"

```
Does the old URL have backlinks or significant traffic?
├── Yes → 301 redirect old → new. Update all internal links.
└── No → 301 redirect anyway (best practice), but lower priority.
```

### 11.3 "What schema should I add?"

```
What type of content is this?
├── Blog post / News → Article or BlogPosting
├── Step-by-step guide → HowTo
├── Page has an FAQ section → FAQPage (in addition to primary schema)
├── Product page → Product
├── Roundup / List → ItemList
├── About / Company page → Organization
└── None of the above → No specific schema. Use BreadcrumbList only.
```

---

## 12. Agent Behavior Rules

### 12.1 Confidence & Escalation

- If the agent is confident (all checklist items pass, no ambiguity) → publish or queue for publish.
- If the agent is uncertain about any item → flag it for human review with a specific note on what's unclear.
- Never silently skip a failed checklist item. Either fix it or escalate it.

### 12.2 Logging

- Log every action: keyword chosen, metadata set, links added, schema applied, checklist results.
- Log format: `[timestamp] [action] [field] [old_value → new_value]`
- Maintain a per-content audit trail that can be reviewed post-publish.

### 12.3 Overrides

- If the user explicitly overrides a playbook rule (e.g., "use this exact title even though it's 75 characters"), comply but log the override with a note.
- Never silently deviate from the playbook without an explicit user instruction.

### 12.4 Tone of Communication

- When reporting to the user, be concise and action-oriented.
- Lead with what was done, then what needs attention.
- Example: "Published 'How to Improve Page Speed' → meta title ✓, schema ✓, 4 internal links added. **Flagged**: no og:image was provided — using default. Please upload a custom image."

---

## Appendix A: Quick Reference — Character Limits

| Field | Min | Max | Notes |
|-------|-----|-----|-------|
| Meta title | 30 | 60 | Truncated at ~580px on desktop |
| Meta description | 120 | 160 | Truncated at ~920px on desktop |
| Slug | — | 5 words | Remove stop words |
| OG title | 30 | 90 | Platform-dependent truncation |
| OG description | 50 | 200 | Conversational tone |
| Alt text | 5 | 125 | Describe the image, not the page |
| H1 | 20 | 70 | One per page, keyword-inclusive |

## Appendix B: Stop Words to Remove from Slugs

a, an, the, and, or, but, in, on, at, to, for, of, with, by, from, is, it, this, that, are, was, were, be, been, being, have, has, had, do, does, did, will, would, shall, should, may, might, can, could

## Appendix C: Regex Patterns for Validation

```regex
# Meta title length
^.{30,60}$

# Slug format (lowercase, hyphenated, no stop words check separate)
^[a-z0-9]+(-[a-z0-9]+)*$

# Meta description length
^.{120,160}$

# Image filename (descriptive, no spaces)
^[a-z0-9]+(-[a-z0-9]+)*\.(png|jpg|jpeg|webp|svg|gif)$
```

---

*Last updated: 2026-03-27. This playbook is a living document. Update it as search engine algorithms, CMS platforms, and content strategy evolve.*
