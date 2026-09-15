import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// The whole monorepo shares one `.env` at the repository root; Next.js only reads
// env files from the app directory, so load the root file here (never overriding
// variables that are already set).
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (!process.env.DATABASE_URL && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {
  // The repository root already carries AGENTS.md/CLAUDE.md for this project.
  agentRules: false,
  // Development is reached as 127.0.0.1 as well as localhost; without this Next
  // blocks its dev/HMR resources cross-origin and the client never hydrates.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Workspace packages export TypeScript source; let Next compile them.
  transpilePackages: ['@notea/protocol', '@notea/db', '@notea/workspace-client', '@notea/agents'],
  // Native/Node-only server dependencies stay external to the server bundle.
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
