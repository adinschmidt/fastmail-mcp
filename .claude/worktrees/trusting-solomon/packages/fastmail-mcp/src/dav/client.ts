import { DAVClient } from 'tsdav';
import { DavConfig } from '../config.js';

export type DavClients = {
  caldav: DAVClient;
  carddav: DAVClient;
};

export function createDavClients(cfg: DavConfig): DavClients {
  const caldav = new DAVClient({
    serverUrl: cfg.caldavUrl,
    credentials: { username: cfg.username, password: cfg.appPassword },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  const carddav = new DAVClient({
    serverUrl: cfg.carddavUrl,
    credentials: { username: cfg.username, password: cfg.appPassword },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  });

  return { caldav, carddav };
}
