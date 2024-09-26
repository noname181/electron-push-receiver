interface ElectronPushReceiver {
    START_NOTIFICATION_SERVICE: string;
    NOTIFICATION_SERVICE_STARTED: string;
    NOTIFICATION_SERVICE_RESTARTED: string;
    NOTIFICATION_SERVICE_ERROR: string;
    NOTIFICATION_RECEIVED: string;
    TOKEN_UPDATED: string;
    // @ts-ignore
    setup: (webContents: Electron.WebContents) => void;
}

declare const electronPushReceiver: ElectronPushReceiver;
export = electronPushReceiver;