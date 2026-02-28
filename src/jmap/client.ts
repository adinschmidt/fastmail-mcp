import { FastmailJmapAuth } from './auth.js';
import { JmapRequest, JmapResponse, JmapSession } from './types.js';

const JMAP_CORE_CAPABILITY = 'urn:ietf:params:jmap:core';
const JMAP_MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const JMAP_SUBMISSION_CAPABILITY = 'urn:ietf:params:jmap:submission';

export class JmapClient {
  private auth: FastmailJmapAuth;
  private session: JmapSession | null = null;

  constructor(auth: FastmailJmapAuth) {
    this.auth = auth;
  }

  async getSession(): Promise<JmapSession> {
    if (this.session) return this.session;

    const res = await fetch(this.auth.getSessionUrl(), { method: 'GET', headers: this.auth.getHeaders() });
    if (!res.ok) {
      throw new Error(`Failed to get JMAP session (${res.status})`);
    }

    const sessionData = (await res.json()) as any;
    const accountId = Object.keys(sessionData.accounts || {})[0];
    if (!accountId) {
      throw new Error('JMAP session missing accounts');
    }

    this.session = {
      apiUrl: sessionData.apiUrl,
      accountId,
      capabilities: sessionData.capabilities || {},
      downloadUrl: sessionData.downloadUrl,
      uploadUrl: sessionData.uploadUrl,
    };

    return this.session;
  }

  async request(req: JmapRequest): Promise<JmapResponse> {
    const session = await this.getSession();
    const res = await fetch(session.apiUrl, {
      method: 'POST',
      headers: this.auth.getHeaders(),
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`JMAP request failed (${res.status})`);
    }
    return (await res.json()) as JmapResponse;
  }

  private getMethodResult(res: JmapResponse, index: number, expectedMethodName: string): any {
    const call = res.methodResponses[index];
    if (!call) {
      throw new Error(`JMAP response missing ${expectedMethodName}`);
    }

    const [name, body] = call;
    if (name === 'error') {
      const type = typeof body?.type === 'string' ? body.type : 'unknown';
      const description = typeof body?.description === 'string' ? body.description : '';
      throw new Error(`JMAP ${expectedMethodName} failed (${type})${description ? `: ${description}` : ''}`);
    }
    if (name !== expectedMethodName) {
      throw new Error(`JMAP response mismatch: expected ${expectedMethodName}, got ${name}`);
    }
    return body;
  }

  private formatSetError(err: any): string {
    const type = typeof err?.type === 'string' ? err.type : 'unknown';
    const description = typeof err?.description === 'string' ? err.description : '';
    return description ? `${type}: ${description}` : type;
  }

  async listMailboxes(): Promise<any[]> {
    const session = await this.getSession();
    const req: JmapRequest = {
      using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY],
      methodCalls: [['Mailbox/get', { accountId: session.accountId }, 'mb']],
    };
    const res = await this.request(req);
    return res.methodResponses[0]?.[1]?.list || [];
  }

  async createMailbox(input: {
    name: string;
    parentId?: string;
    role?: string | null;
    sortOrder?: number;
    isSubscribed?: boolean;
  }): Promise<any> {
    const session = await this.getSession();
    const createId = 'mbox';
    const create: any = { name: input.name };
    if (input.parentId !== undefined) create.parentId = input.parentId;
    if (input.role !== undefined) create.role = input.role;
    if (input.sortOrder !== undefined) create.sortOrder = input.sortOrder;
    if (input.isSubscribed !== undefined) create.isSubscribed = input.isSubscribed;

    const req: JmapRequest = {
      using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY],
      methodCalls: [['Mailbox/set', { accountId: session.accountId, create: { [createId]: create } }, 'mbSet']],
    };
    const res = await this.request(req);
    const body = this.getMethodResult(res, 0, 'Mailbox/set');
    const failed = body?.notCreated?.[createId];
    if (failed) {
      throw new Error(`Failed to create mailbox: ${this.formatSetError(failed)}`);
    }

    const created = body?.created?.[createId];
    if (!created?.id) {
      throw new Error('Mailbox creation did not return an id');
    }
    return created;
  }

  async updateMailbox(
    mailboxId: string,
    update: {
      name?: string;
      parentId?: string | null;
      sortOrder?: number;
      isSubscribed?: boolean;
    }
  ): Promise<any> {
    if (Object.keys(update).length === 0) {
      throw new Error('At least one mailbox property must be provided');
    }

    const session = await this.getSession();
    const req: JmapRequest = {
      using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY],
      methodCalls: [['Mailbox/set', { accountId: session.accountId, update: { [mailboxId]: update } }, 'mbSet']],
    };
    const res = await this.request(req);
    const body = this.getMethodResult(res, 0, 'Mailbox/set');
    const failed = body?.notUpdated?.[mailboxId];
    if (failed) {
      throw new Error(`Failed to update mailbox ${mailboxId}: ${this.formatSetError(failed)}`);
    }
    return body?.updated?.[mailboxId] ?? { id: mailboxId };
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    const session = await this.getSession();
    const req: JmapRequest = {
      using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY],
      methodCalls: [['Mailbox/set', { accountId: session.accountId, destroy: [mailboxId] }, 'mbSet']],
    };
    const res = await this.request(req);
    const body = this.getMethodResult(res, 0, 'Mailbox/set');
    const failed = body?.notDestroyed?.[mailboxId];
    if (failed) {
      throw new Error(`Failed to delete mailbox ${mailboxId}: ${this.formatSetError(failed)}`);
    }
  }

  async listEmails(mailboxId?: string, limit: number = 20): Promise<any[]> {
    const session = await this.getSession();
    const filter = mailboxId ? { inMailbox: mailboxId } : {};
    const req: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        [
          'Email/query',
          {
            accountId: session.accountId,
            filter,
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit,
          },
          'q',
        ],
        [
          'Email/get',
          {
            accountId: session.accountId,
            '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
            properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview', 'hasAttachment', 'keywords', 'threadId'],
          },
          'g',
        ],
      ],
    };
    const res = await this.request(req);
    return res.methodResponses[1]?.[1]?.list || [];
  }

  async getEmail(emailId: string): Promise<any> {
    const session = await this.getSession();
    const req: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        [
          'Email/get',
          {
            accountId: session.accountId,
            ids: [emailId],
            properties: [
              'id',
              'subject',
              'from',
              'to',
              'cc',
              'bcc',
              'receivedAt',
              'preview',
              'keywords',
              'textBody',
              'htmlBody',
              'attachments',
              'bodyValues',
            ],
            bodyProperties: ['partId', 'blobId', 'type', 'size', 'name'],
            fetchTextBodyValues: true,
            fetchHTMLBodyValues: true,
          },
          'e',
        ],
      ],
    };
    const res = await this.request(req);
    const list = res.methodResponses[0]?.[1]?.list;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('Email not found');
    }
    return list[0];
  }

  async searchEmails(query: string, limit: number = 20): Promise<any[]> {
    const session = await this.getSession();
    const req: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        [
          'Email/query',
          {
            accountId: session.accountId,
            filter: { text: query },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit,
          },
          'q',
        ],
        [
          'Email/get',
          {
            accountId: session.accountId,
            '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
            properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'preview', 'hasAttachment', 'keywords', 'threadId'],
          },
          'g',
        ],
      ],
    };
    const res = await this.request(req);
    return res.methodResponses[1]?.[1]?.list || [];
  }

  async getIdentities(): Promise<any[]> {
    const session = await this.getSession();
    const req: JmapRequest = {
      using: [JMAP_CORE_CAPABILITY, JMAP_SUBMISSION_CAPABILITY],
      methodCalls: [['Identity/get', { accountId: session.accountId }, 'ids']],
    };
    const res = await this.request(req);
    return res.methodResponses[0]?.[1]?.list || [];
  }

  async sendEmail(input: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    from?: string;
    subject: string;
    textBody?: string;
    htmlBody?: string;
  }): Promise<{ submissionId: string; emailId?: string }>
  {
    const session = await this.getSession();

    const identities = await this.getIdentities();
    if (!identities.length) throw new Error('No sending identities found');

    const selectedIdentity = input.from
      ? identities.find((i: any) => (i.email || '').toLowerCase() === input.from!.toLowerCase())
      : identities.find((i: any) => i.mayDelete === false) || identities[0];

    if (!selectedIdentity) throw new Error('No matching identity found');
    if (input.from && !selectedIdentity) throw new Error('From address is not a verified identity');

    if (!input.textBody && !input.htmlBody) {
      throw new Error('Either textBody or htmlBody is required');
    }

    const emailObject: any = {
      mailboxIds: {},
      keywords: { $draft: true },
      from: [{ email: selectedIdentity.email }],
      to: input.to.map((email) => ({ email })),
      cc: (input.cc || []).map((email) => ({ email })),
      bcc: (input.bcc || []).map((email) => ({ email })),
      subject: input.subject,
      bodyValues: {},
    };

    if (input.textBody) {
      emailObject.textBody = [{ partId: 'text', type: 'text/plain' }];
      emailObject.bodyValues.text = { value: input.textBody };
    }
    if (input.htmlBody) {
      emailObject.htmlBody = [{ partId: 'html', type: 'text/html' }];
      emailObject.bodyValues.html = { value: input.htmlBody };
    }

    // Put draft in Drafts, then move to Sent on success.
    const mailboxes = await this.listMailboxes();
    const drafts = mailboxes.find((m: any) => m.role === 'drafts') || mailboxes.find((m: any) => /draft/i.test(m.name || ''));
    const sent = mailboxes.find((m: any) => m.role === 'sent') || mailboxes.find((m: any) => /sent/i.test(m.name || ''));
    if (!drafts) throw new Error('Drafts mailbox not found');
    if (!sent) throw new Error('Sent mailbox not found');

    emailObject.mailboxIds[drafts.id] = true;

    const sentMailboxIds: Record<string, boolean> = {};
    sentMailboxIds[sent.id] = true;

    const req: JmapRequest = {
      using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY, JMAP_SUBMISSION_CAPABILITY],
      methodCalls: [
        ['Email/set', { accountId: session.accountId, create: { draft: emailObject } }, 'createEmail'],
        [
          'EmailSubmission/set',
          {
            accountId: session.accountId,
            create: {
              submission: {
                emailId: '#draft',
                identityId: selectedIdentity.id,
                envelope: {
                  mailFrom: { email: selectedIdentity.email },
                  rcptTo: input.to.map((email) => ({ email })),
                },
              },
            },
            onSuccessUpdateEmail: {
              '#draft': {
                mailboxIds: sentMailboxIds,
                keywords: { $seen: true },
              },
            },
          },
          'submitEmail',
        ],
      ],
    };

    const res = await this.request(req);
    const emailRes = res.methodResponses[0]?.[1];
    const subRes = res.methodResponses[1]?.[1];

    const createdEmailId = emailRes?.created?.draft?.id;
    const submissionId = subRes?.created?.submission?.id;
    if (!submissionId) {
      throw new Error('Email submission failed');
    }
    return { submissionId, emailId: createdEmailId };
  }

  async markEmailRead(emailId: string, read: boolean): Promise<void> {
    const session = await this.getSession();
    const keywords = read ? { $seen: true } : {};
    const req: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/set', { accountId: session.accountId, update: { [emailId]: { keywords } } }, 'u']],
    };
    const res = await this.request(req);
    const u = res.methodResponses[0]?.[1];
    if (u?.notUpdated?.[emailId]) {
      throw new Error('Failed to update email');
    }
  }

  async moveEmail(emailId: string, targetMailboxId: string): Promise<void> {
    const session = await this.getSession();
    const mailboxIds: Record<string, boolean> = {};
    mailboxIds[targetMailboxId] = true;
    const req: JmapRequest = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/set', { accountId: session.accountId, update: { [emailId]: { mailboxIds } } }, 'm']],
    };
    const res = await this.request(req);
    const m = res.methodResponses[0]?.[1];
    if (m?.notUpdated?.[emailId]) {
      throw new Error('Failed to move email');
    }
  }

  async deleteEmail(emailId: string): Promise<void> {
    const mailboxes = await this.listMailboxes();
    const trash = mailboxes.find((m: any) => m.role === 'trash') || mailboxes.find((m: any) => /trash/i.test(m.name || ''));
    if (!trash) throw new Error('Trash mailbox not found');
    await this.moveEmail(emailId, trash.id);
  }

  async getEmailAttachments(emailId: string): Promise<any[]> {
    const e = await this.getEmail(emailId);
    return e.attachments || [];
  }

  async getAttachmentDownloadUrl(emailId: string, attachmentId: string): Promise<string> {
    const session = await this.getSession();
    const e = await this.getEmail(emailId);
    const attachments = e.attachments || [];
    const attachment = attachments.find((a: any) => a.partId === attachmentId || a.blobId === attachmentId) || attachments[Number(attachmentId)];
    if (!attachment) throw new Error('Attachment not found');
    if (!session.downloadUrl) throw new Error('JMAP downloadUrl not available');
    return session.downloadUrl
      .replace('{accountId}', session.accountId)
      .replace('{blobId}', attachment.blobId)
      .replace('{type}', encodeURIComponent(attachment.type || 'application/octet-stream'))
      .replace('{name}', encodeURIComponent(attachment.name || 'attachment'));
  }
}
