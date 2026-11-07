// Electron main script for make-icons.mjs: draws an SVG into a transparent 1024 px PNG.
// Chromium keeps the SVG's drop shadows and the transparent margin; qlmanage fills the margin with white
// and sips drops feDropShadow. The window is offscreen and never shown.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const [svgPath, outPath] = process.argv.slice(-2);
app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(svgPath).toString('base64');
  const html = `<html><body style="margin:0;background:transparent"><img width="1024" height="1024" src="data:image/svg+xml;base64,${svg}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  // Let the image decode and paint before capturing.
  await new Promise(resolve => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(outPath, image.toPNG());
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
