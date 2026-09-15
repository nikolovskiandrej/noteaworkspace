import { OrchestratorClient } from '@notea/workspace-client';
import { env } from './env';

export { OrchestratorClient, OrchestratorError, type OrchestratorClientOptions } from '@notea/workspace-client';

let cached: OrchestratorClient | null = null;

export function getOrchestrator(): OrchestratorClient {
  if (cached) return cached;
  const config = env();
  cached = new OrchestratorClient({ baseUrl: config.ORCHESTRATOR_URL, apiKey: config.ORCHESTRATOR_API_KEY });
  return cached;
}
