// The page width a layout check asks for. On Windows the window size includes its frame, so the frame is added; on macOS
// it is 0 and the window gets the same size as before.
export async function resizeWindow(app, page, width, height) {
  const deadline = Date.now() + 30_000;
  // The resize is asked for again while waiting: a single request was sometimes not applied (cause not found).
  for (;;) {
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const frameWidth = window.getSize()[0] - window.getContentSize()[0];
      window.setSize(width + frameWidth, height);
    }, { width, height });
    if (await page.evaluate(width => innerWidth === width, width)) break;
    if (Date.now() > deadline) throw new Error(`The page did not reach ${width}px wide`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Two frames, so layout that follows the width (resize observers, the map's measured size) has run.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
