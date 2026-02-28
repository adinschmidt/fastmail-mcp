import { FastmailAuthConfig } from '../config.js';

export class FastmailJmapAuth {
  private cfg: FastmailAuthConfig;

  constructor(cfg: FastmailAuthConfig) {
    this.cfg = cfg;
  }

  getSessionUrl(): string {
    return `${this.cfg.baseUrl}/jmap/session`;
  }

  getHeaders(): Record<string, string> {
    const common: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.cfg.kind === 'bearer') {
      return { ...common, Authorization: `Bearer ${this.cfg.apiToken}` };
    }

    const token = Buffer.from(`${this.cfg.username}:${this.cfg.appPassword}`, 'utf8').toString('base64');
    return { ...common, Authorization: `Basic ${token}` };
  }
}
