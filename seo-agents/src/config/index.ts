import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(optional('PORT', '4000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  isDev: optional('NODE_ENV', 'development') === 'development',

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: required('SUPABASE_ANON_KEY'),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: optional('JWT_EXPIRES_IN', '30d'),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },

  google: {
    clientId: optional('GOOGLE_CLIENT_ID', ''),
    clientSecret: optional('GOOGLE_CLIENT_SECRET', ''),
    redirectUri: optional('GOOGLE_REDIRECT_URI', ''),
  },

  encryption: {
    key: required('ENCRYPTION_KEY'),
  },
} as const;
