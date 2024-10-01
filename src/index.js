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
let lastCredential = null;

// To be sure that start is called only once
let started = false;

// FcmClient instance used for manual socket reconnection
let lastClient = null;

// Variable to prevent duplicate restarts when
// multiple socket close events are triggered
const SOCKET_CLOSED_DELAY_THRESHOLD = 10000;
let lastClosedTimeInMills = 0;
let isTryingReconnect = false;

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
      lastCredential = credentials;
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
  // Disconnect last connected socket manually
  if (started && lastClient != null) {
    lastClient.disconnect();
  }

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

  function calculateThreshold() {
    const timeNow = Date.now();
    const isExceedThreshold = (timeNow - lastClosedTimeInMills > SOCKET_CLOSED_DELAY_THRESHOLD);
    lastClosedTimeInMills = timeNow;
    return isExceedThreshold;
  }

  // Listen for FCM server connection failure
  // Handling for TCP/TLS socket closed
  client.getSocket().on('close', () => {
    if (calculateThreshold() && !isTryingReconnect) {
      isTryingReconnect = true;
      tryRestart(webContents, authSecret, ecdh);
      isTryingReconnect = false;
    } else {
      webContents.send(NOTIFICATION_SERVICE_ERROR, 'PUSH_RECEIVER:::Socket closed, But not reconnect since already trying reconnection');
    }
  });

  // Renew last client instance for manual socket disconnection
  lastClient = client;
}

async function tryRestart(webContents, authSecret, ecdh) {
  webContents.send(NOTIFICATION_SERVICE_ERROR, 'PUSH_RECEIVER:::Socket closed, Trying to reopen fcm socket');
  if (!webContents.isDestroyed() && lastCredential != null) {
    try {
      // Using previously generated credential for login token consistency
      await initClient(webContents, lastCredential, authSecret, ecdh);
      webContents.send(NOTIFICATION_SERVICE_RESTARTED, lastCredential.token);
    } catch (e) {
      catchException(webContents, e);
    }
  } else {
    webContents.send(NOTIFICATION_SERVICE_ERROR, 'PUSH_RECEIVER:::Socket reopen failed due to webContent or lastCredential instance is not initialized');
  }
}

function catchException(webContents, e) {
  console.error('PUSH_RECEIVER:::Error while starting the service', e);
  // Forward error to the renderer process
  webContents.send(NOTIFICATION_SERVICE_ERROR, e.message);
}
