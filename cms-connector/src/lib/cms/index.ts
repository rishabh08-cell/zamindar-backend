import type { CMSAdapter, CMSPlatform } from '../../types';
import { WordPressAdapter } from './adapters/wordpress';
import { StrapiAdapter } from './adapters/strapi';

const adapterRegistry: Record<CMSPlatform, new () => CMSAdapter> = {
  wordpress: WordPressAdapter,
  strapi: StrapiAdapter,
};

export function createAdapter(platform: CMSPlatform): CMSAdapter {
  const AdapterClass = adapterRegistry[platform];
  if (!AdapterClass) {
    throw new Error(`Unsupported CMS platform: ${platform}. Supported: ${Object.keys(adapterRegistry).join(', ')}`);
  }
  return new AdapterClass();
}

export function getSupportedPlatforms(): CMSPlatform[] {
  return Object.keys(adapterRegistry) as CMSPlatform[];
}

export { WordPressAdapter } from './adapters/wordpress';
export { StrapiAdapter } from './adapters/strapi';
