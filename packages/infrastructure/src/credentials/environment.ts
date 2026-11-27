import { PlatformError, type CredentialResolver } from '@digital-worker/core';
export class EnvironmentCredentials implements CredentialResolver {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  available(ref: string) {
    return /^env:[A-Z][A-Z0-9_]*$/.test(ref) && Boolean(this.env[ref.slice(4)]?.trim());
  }
  resolve(ref: string) {
    if (!this.available(ref)) throw new PlatformError('MODEL_NOT_CONFIGURED', '模型凭证未配置');
    return this.env[ref.slice(4)]!.trim();
  }
}
