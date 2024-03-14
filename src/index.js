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
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_RECEIVED,
  TOKEN_UPDATED,
} = require('./constants');

const config = new Store();

module.exports = {
  START_NOTIFICATION_SERVICE,
  NOTIFICATION_SERVICE_STARTED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_RECEIVED,
  TOKEN_UPDATED,
  setup,
};

// To be sure that start is called only once
let started = false;

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

    try {
      // Register if no credentials or if senderId has changed
      [credentials] = await Promise.all([registerToFCM({
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
      })]);
      const credentialsStringify = credentials;
      credentialsStringify.acg.id = credentialsStringify.acg.id.toString();
      credentialsStringify.acg.securityToken = credentialsStringify.acg.securityToken.toString();
      config.set('credentials', credentialsStringify);
      config.set('appID', appID);
      webContents.send(TOKEN_UPDATED, credentials.token);

      credentials.acg.id = BigInt(credentials.acg.id);
      credentials.acg.securityToken = BigInt(credentials.acg.securityToken);

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
      webContents.send(NOTIFICATION_SERVICE_STARTED, credentials.token);
    } catch (e) {
      console.error('PUSH_RECEIVER:::Error while starting the service', e);
      // Forward error to the renderer process
      webContents.send(NOTIFICATION_SERVICE_ERROR, e.message);
    }
  });
}
