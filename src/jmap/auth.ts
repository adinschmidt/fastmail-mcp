import { JmapAuthConfig } from '../config.js';

export class JmapAuth {
  private cfg: JmapAuthConfig;

  constructor(cfg: JmapAuthConfig) {
    this.cfg = cfg;
  }

  getSessionUrl(): string {
    return this.cfg.sessionUrl;
  }

  getHeaders(): Record<string, string> {
    const common: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.cfg.kind === 'bearer') {
      return { ...common, Authorization: `Bearer ${this.cfg.apiToken}` };
    }

    const token = Buffer.from(`${this.cfg.username}:${this.cfg.password}`, 'utf8').toString('base64');
    return { ...common, Authorization: `Basic ${token}` };
  }
}
