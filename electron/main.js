const { app, BrowserWindow, shell } = require("electron");

const APP_URL =
  process.env.APP_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:3000" : "https://friend-id-call-site.onrender.com");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 680,
    autoHideMenuBar: true,
    title: "Friend ID Call",
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
