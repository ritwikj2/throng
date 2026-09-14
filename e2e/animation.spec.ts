import { test, expect } from "./fixtures";

for (const dpr of [1, 2]) {
  test(`renders at display refresh with device pixel ratio ${dpr}`, async ({
    browser,
    app,
  }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const observed = window as typeof window & { __throngPaints: number };
      observed.__throngPaints = 0;
      const original = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = new Proxy(original, {
        apply(target, receiver, args) {
          const canvas = (receiver as CanvasRenderingContext2D).canvas;
          if (
            canvas.dataset.testid === "world-canvas" &&
            args.length === 5 &&
            args[1] === 0 &&
            args[2] === 0
          )
            observed.__throngPaints++;
          return Reflect.apply(target, receiver, args);
        },
      });
    });
    try {
      await page.goto(app.url);
      await page.getByRole("button", { name: "Hatch the egg" }).click();
      await expect(page.getByTestId("world-canvas")).toBeVisible();
      const stats = await page.evaluate(async () => {
        const observed = window as typeof window & { __throngPaints: number };
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const start = performance.now();
        const before = observed.__throngPaints;
        let frames = 0;
        await new Promise<void>((resolve) => {
          const frame = () => {
            frames++;
            if (performance.now() - start >= 1400) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
        const elapsed = performance.now() - start;
        const paints = observed.__throngPaints - before;
        return {
          frames,
          paints,
          elapsed,
          ratio: paints / frames,
          displayFps: (frames / elapsed) * 1000,
          paintFps: (paints / elapsed) * 1000,
        };
      });
      await testInfo.attach("animation-measurement", {
        body: JSON.stringify(stats, null, 2),
        contentType: "application/json",
      });
      expect(stats.frames).toBeGreaterThan(15);
      expect(stats.ratio).toBeGreaterThan(0.9);
      expect(stats.ratio).toBeLessThan(1.1);
      const size = await page.getByTestId("world-canvas").evaluate((canvas) => ({
        buffer: (canvas as HTMLCanvasElement).width,
        css: canvas.getBoundingClientRect().width,
        dpr: devicePixelRatio,
      }));
      expect(Math.abs(size.buffer - size.css * dpr)).toBeLessThan(2);
    } finally {
      await context.close();
    }
  });
}
