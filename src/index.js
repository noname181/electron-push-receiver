/* global BigInt */
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

    const authSecret = generateFcmAuthSecret();
    const ecdh = createFcmECDH();

    try {
      // Register if no credentials or if senderId has changed
      if (!credentials || savedAppID !== appID) {
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

        // Change BigInt variables into String in order to Jsonify
        const credentialsStringify = credentials;
        credentialsStringify.acg.id = credentialsStringify.acg.id.toString();
        credentialsStringify.acg.securityToken = credentialsStringify.acg.securityToken.toString();

        // Save credentials for later use
        config.set('credentials', credentialsStringify);
        // Save appID
        config.set('appID', appID);
        // Notify the renderer process that the FCM token has changed
        webContents.send(TOKEN_UPDATED, credentials.token);
      }

      credentials.acg.id = BigInt(credentials.acg.id);
      credentials.acg.securityToken = BigInt(credentials.acg.securityToken);

      console.log(credentials); // TODO: Delete log later
      const client = new FcmClient({
        acg: {
          id: credentials.acg.id,
          securityToken: credentials.acg.securityToken,
        },
        ece: {
          authSecret,
          privateKey: ecdh.getPrivateKey(),
        },
      });
      console.log(client); // TODO: Delete log later

      // Will be called on new notification
      client.on('message', (message) => {
        console.log(message); // TODO: Delete log later
        // Notify the renderer process that a new notification has been received
        // And check if window is not destroyed for darwin Apps
        if (!webContents.isDestroyed()) {
          webContents.send(NOTIFICATION_RECEIVED, message);
        }
      });

      client.on('message-data', (data) => {
        console.log(data); // TODO: Delete log later
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
