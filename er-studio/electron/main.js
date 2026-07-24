// ER Studio - Electron shell
// Embeds the ER Studio server in-process and hosts the UI in a native window.
// Solves the focus problem: when the simulator launches and macOS activates
// its window, ER Studio takes focus back.

const { app, BrowserWindow, shell } = require('electron');
const { execSync } = require('child_process');
const path = require('path');

let win = null;
let serverHandle = null;

// GUI apps launched from Finder get a minimal PATH (no /usr/local/bin,
// /opt/homebrew/bin, nvm, etc.), which would break spawning npm/npx.
// Resolve the user's login-shell PATH once and adopt it.
function adoptLoginShellPath() {
  if (process.platform === 'win32') return;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const out = execSync(`${sh} -ilc 'echo -n "$PATH"'`, { timeout: 5000 }).toString();
    if (out && out.length > 10) process.env.PATH = out;
  } catch {
    process.env.PATH = `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`;
  }
}

// When the simulator spawns, macOS activates its window. Hide it (we mirror
// its framebuffer anyway) and take focus back. Runs a few times over the
// following seconds because npx cold-starts delay the window's appearance.
// Requires the one-time "control System Events" permission on first use.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

function userConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.er-studio.json'), 'utf8')); }
  catch { return {}; }
}

function hideSimulatorWindow() {
  if (process.platform !== 'darwin') return;
  const script = `
    tell application "System Events"
      repeat with p in (every process whose visible is true)
        set pname to name of p
        if pname is not "ER Studio" and pname is not "Electron" then
          if pname contains "evenhub" or pname contains "simulator" then
            set visible of p to false
          else
            try
              repeat with w in windows of p
                if name of w contains "even" then
                  set visible of p to false
                  exit repeat
                end if
              end repeat
            end try
          end if
        end if
      end repeat
    end tell`;
  execFile('osascript', ['-e', script], { timeout: 5000 }, err => {
    if (err && /not allowed|1743|assistive/i.test(String(err))) {
      console.error('[er-studio] cannot hide simulator window - grant permission in System Settings > Privacy & Security > Automation / Accessibility for ER Studio');
    }
  });
}

function scheduleFocusRecapture() {
  const hide = userConfig().hideSimulator !== false; // default on
  for (const delay of [1200, 3000, 6000, 10000]) {
    setTimeout(() => {
      if (hide) hideSimulatorWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        app.focus({ steal: true });
      }
    }, delay);
  }
}

async function boot() {
  adoptLoginShellPath();

  const { startServer } = require(path.join(__dirname, '..', 'server', 'index.js'));
  // port 0 = pick a free port, so a browser-mode instance on 4477 can coexist
  serverHandle = await startServer({ port: 0 });

  win = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#080b11',
    title: 'ER Studio',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setMenuBarVisibility(false);

  // External links (OPEN webview button etc.) go to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  let lastSimAlive = false;
  serverHandle.events.on('event', msg => {
    if (msg.type === 'status') {
      if (msg.state.simAlive && !lastSimAlive) scheduleFocusRecapture();
      lastSimAlive = msg.state.simAlive;
    }
  });

  await win.loadURL(`http://127.0.0.1:${serverHandle.port}`);
}

app.whenReady().then(boot).catch(err => {
  console.error('[er-studio] fatal:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (serverHandle) serverHandle.close();
  app.quit();
});

app.on('before-quit', () => {
  if (serverHandle) serverHandle.close();
});
