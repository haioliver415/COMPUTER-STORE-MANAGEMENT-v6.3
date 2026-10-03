const { app, BrowserWindow, dialog } = require('electron');
const { startServer } = require('./server');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    title: 'Computer Store Management System V6.3',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL('http://127.0.0.1:3000');
  mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function boot() {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error('Application startup failed:', err);
    await dialog.showMessageBox({
      type: 'error',
      title: 'Computer Store Management System V6.3',
      message: 'The application could not start.',
      detail: `${err.message}\n\nThe web server normally stays open and shows Database Setup if PostgreSQL is unavailable. If this dialog appears, check port 3000 and application files.`,
      buttons: ['Close']
    });
    app.quit();
  }
}

app.whenReady().then(boot);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
