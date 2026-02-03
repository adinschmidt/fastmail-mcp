export type JmapSession = {
  apiUrl: string;
  accountId: string;
  capabilities: Record<string, any>;
  downloadUrl?: string;
  uploadUrl?: string;
};

export type JmapRequest = {
  using: string[];
  methodCalls: [string, any, string][];
};

export type JmapResponse = {
  methodResponses: Array<[string, any, string]>;
  sessionState: string;
};
