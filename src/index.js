/* global BigInt */
const {
  createFcmECDH,
  generateFcmAuthSecret,
  registerToFCM,
  FcmClient,
} = require('@aracna/fcm');

const { ipcMain } = require('electron');
const Store = require('electron-store');

const {
  START_NOTIFICATION_SERVICE,
  NOTIFICATION_SERVICE_STARTED,
  NOTIFICATION_SERVICE_RESTARTED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_RECEIVED,
  TOKEN_UPDATED,
} = require('./constants');

// Static store object that used for save credential cache to local storage
const config = new Store();

// All the credentials that previously specified by using project
let credentialConfig;

// To be sure that start is called only once
let started = false;

// noinspection JSUnusedGlobalSymbols
module.exports = {
  START_NOTIFICATION_SERVICE,
  NOTIFICATION_SERVICE_STARTED,
  NOTIFICATION_SERVICE_RESTARTED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_RECEIVED,
  TOKEN_UPDATED,
  setup,
};

// To be call from the main process
function setup(webContents) {
  // Will be called by the renderer process
  ipcMain.on(START_NOTIFICATION_SERVICE, async (_, appID, projectID, apiKey, vapidKey) => {
    // Retrieve saved credentials
    let credentials = config.get('credentials');

    if (started) {
      webContents.send(NOTIFICATION_SERVICE_STARTED, (credentials || {}).token);
      return;
    }
    started = true;

    const authSecret = generateFcmAuthSecret();
    const ecdh = createFcmECDH();

    credentials = null;
    credentialConfig = {
      appID,
      ece: {
        authSecret,
        publicKey: ecdh.getPublicKey(),
      },
      firebase: {
        apiKey,
        appID,
        projectID,
      },
      vapidKey,
    };

    try {
      credentials = await initCredential(webContents);
      await initClient(webContents, credentials, authSecret, ecdh);
      webContents.send(NOTIFICATION_SERVICE_STARTED, credentials.token);
    } catch (e) {
      catchException(webContents, e);
    }
  });
}

async function initCredential(webContents) {
  // Register if no credentials or if senderId has changed
  const issuedCredential = await Promise.all([registerToFCM(credentialConfig)]);
  const registeredCredential = issuedCredential[0];
  const credentialsStringify = registeredCredential;

  credentialsStringify.acg.id = credentialsStringify.acg.id.toString();
  credentialsStringify.acg.securityToken = credentialsStringify.acg.securityToken.toString();
  config.set('credentials', credentialsStringify);
  config.set('appID', credentialConfig.appID);
  webContents.send(TOKEN_UPDATED, registeredCredential.token);

  registeredCredential.acg.id = BigInt(registeredCredential.acg.id);
  registeredCredential.acg.securityToken = BigInt(registeredCredential.acg.securityToken);
  return registeredCredential;
}

async function initClient(webContents, credentials, authSecret, ecdh) {
  const client = new FcmClient({
    acg: credentials.acg,
    ece: {
      authSecret,
      privateKey: ecdh.getPrivateKey(),
    },
  });

  // Will be called on new notification
  client.on('message-data', (data) => {
    // Notify the renderer process that a new notification has been received
    // And check if window is not destroyed for darwin Apps
    if (!webContents.isDestroyed()) {
      webContents.send(NOTIFICATION_RECEIVED, data);
    }
  });

  // Listen for GCM/FCM notifications
  await client.connect();

  // Listen for FCM server connection failure
  // Handling for MCS disconnection
  client.on('close', () => {
    tryRestart(webContents, authSecret, ecdh);
  });

  // Handling for TCP/TLS socket closed
  client.getSocket().on('close', () => {
    tryRestart(webContents, authSecret, ecdh);
  });
}

async function tryRestart(webContents, authSecret, ecdh) {
  webContents.send(NOTIFICATION_SERVICE_ERROR, 'PUSH_RECEIVER:::Socket closed, Trying to reopen fcm socket');
  if (!webContents.isDestroyed()) {
    try {
      const renewCredential = initCredential(webContents);
      await initClient(webContents, renewCredential, authSecret, ecdh);
      webContents.send(NOTIFICATION_SERVICE_RESTARTED, renewCredential.token);
    } catch (e) {
      catchException(webContents, e);
    }
  } else {
    webContents.send(NOTIFICATION_SERVICE_ERROR, 'PUSH_RECEIVER:::Socket reopen failed due to webContent or FcmClClient instance is not initialized');
  }
}

function catchException(webContents, e) {
  console.error('PUSH_RECEIVER:::Error while starting the service', e);
  // Forward error to the renderer process
  webContents.send(NOTIFICATION_SERVICE_ERROR, e.message);
}
