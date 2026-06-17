import { AzureOpenAI } from 'openai';
import { ipv4Fetch } from './ipv4-fetch';

/**
 * Azure OpenAI client factory — single place that knows the deployment + config.
 * Mirrors the reference integration (apiKey + instance + deployment + ipv4 fetch),
 * but defaults to a Responses-API-capable api-version and reads everything from env.
 */

// Responses API needs a recent api-version; override per deployment/region if needed.
const DEFAULT_API_VERSION = '2025-03-01-preview';

export function hasAzureConfig(): boolean {
  return Boolean(
    process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_INSTANCE_NAME &&
      process.env.AZURE_OPENAI_CHAT_DEPLOYMENT,
  );
}

export function getChatDeployment(): string {
  const dep = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
  if (!dep) throw new Error('AZURE_OPENAI_CHAT_DEPLOYMENT is not set.');
  return dep;
}

/** Build a configured AzureOpenAI client. Throws a clear error if unconfigured. */
export function getAzureClient(): AzureOpenAI {
  if (!hasAzureConfig()) {
    throw new Error(
      'Azure OpenAI is not configured. Set AZURE_OPENAI_API_KEY, AZURE_OPENAI_INSTANCE_NAME, and ' +
        'AZURE_OPENAI_CHAT_DEPLOYMENT in .env.local (optionally AZURE_OPENAI_API_VERSION).',
    );
  }
  return new AzureOpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: `https://${process.env.AZURE_OPENAI_INSTANCE_NAME}.openai.azure.com`,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION,
    deployment: getChatDeployment(),
    fetch: ipv4Fetch,
    maxRetries: 1,
  });
}
