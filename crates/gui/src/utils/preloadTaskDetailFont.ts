const DETAIL_FONTS = [
  "italic 400 20px Newsreader",
  "400 13px Geist",
  '400 11px "JetBrains Mono"',
];

/** Warm the detail typography without making font availability a boot requirement. */
export function preloadTaskDetailFont(
  fonts: Pick<FontFaceSet, "load"> | undefined = document.fonts
): Promise<void> {
  if (!fonts?.load) return Promise.resolve();
  return Promise.all(
    DETAIL_FONTS.map((font) =>
      Promise.resolve().then(() => fonts.load(font, "Realtime task 0123456789"))
    )
  ).then(
    () => undefined,
    () => undefined
  );
}

/** CSS @font-face declarations must exist before FontFaceSet.load can match them. */
export async function preloadTaskDetailFontAfterStyles(): Promise<void> {
  if (document.readyState !== "complete")
    await new Promise<void>((resolve) =>
      window.addEventListener("load", () => resolve(), { once: true })
    );
  await preloadTaskDetailFont();
  if (document.fonts) await document.fonts.ready.catch(() => undefined);
}
