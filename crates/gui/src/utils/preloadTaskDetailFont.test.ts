import { expect, it, vi } from "vitest";
import { preloadTaskDetailFont } from "./preloadTaskDetailFont";
it("lets callers continue while fonts are still loading", async () => {
  const finish: Array<(faces: FontFace[]) => void> = [];
  const load = vi.fn(
    () => new Promise<FontFace[]>((resolve) => finish.push(resolve))
  );
  let settled = false;
  const pending = preloadTaskDetailFont({ load }).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(3);
  expect(settled).toBe(false);
  finish.forEach((resolve) => resolve([]));
  await pending;
  expect(settled).toBe(true);
});
it("tolerates offline and synchronous font-loading failures", async () => {
  await expect(
    preloadTaskDetailFont({
      load: vi.fn().mockRejectedValue(new Error("offline")),
    })
  ).resolves.toBeUndefined();
  await expect(
    preloadTaskDetailFont({
      load: vi.fn(() => {
        throw new Error("unsupported");
      }),
    })
  ).resolves.toBeUndefined();
});
it("works without the font-loading API", async () => {
  await expect(preloadTaskDetailFont(undefined)).resolves.toBeUndefined();
});
