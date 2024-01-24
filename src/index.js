const {
  createFcmECDH,
  generateFcmAuthSecret,
  registerToFCM,
  FcmClient,
} = require('@aracna/fcm');

const { ipcMain } = require('electron');
const Config = require('electron-config');
const {
  START_NOTIFICATION_SERVICE,
  NOTIFICATION_SERVICE_STARTED,
  NOTIFICATION_SERVICE_ERROR,
  NOTIFICATION_RECEIVED,
  TOKEN_UPDATED,
} = require('./constants');

const config = new Config();

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
    // Retrieve saved appId
    const savedAppID = config.get('appID');

    if (started) {
      webContents.send(NOTIFICATION_SERVICE_STARTED, (credentials || {}).token);
      return;
    }
    started = true;

    try {
      // Register if no credentials or if senderId has changed
      if (!credentials || savedAppID !== appID) {
        const authSecret = generateFcmAuthSecret();
        const ecdh = createFcmECDH();

        credentials = await registerToFCM({
          appID,
          ece: { authSecret, publicKey: ecdh.getPublicKey() },
          firebase: { apiKey, appID, projectID },
          vapidKey,
        });

        // Save credentials for later use
        config.set('credentials', credentials);
        // Save appID
        config.set('appID', appID);
        // Notify the renderer process that the FCM token has changed
        webContents.send(TOKEN_UPDATED, credentials.token);
      }

      const client = new FcmClient(credentials);
      // Will be called on new notification
      client.on('message-data', (notification) => {
        // Notify the renderer process that a new notification has been received
        // And check if window is not destroyed for darwin Apps
        if (!webContents.isDestroyed()) {
          webContents.send(NOTIFICATION_RECEIVED, notification);
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
