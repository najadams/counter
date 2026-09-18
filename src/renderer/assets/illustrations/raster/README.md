# Real artwork for Counter Friendly

Drop a picture in this folder and the Friendly build uses it instead of the
line drawing of the same name. Nothing else changes — no code edit, no
migration, no rebuild of the standard Counter build (only the Friendly bundle
pulls these bytes in).

## The contract

- **Filename is the illustration name.** `sell.webp` replaces `sell.svg`,
  `receive-stock.png` replaces `receive-stock.svg`. The names are the union in
  `IllustrationName` in `../../../components/friendly/TaskIllustration.tsx`; a
  file whose name isn't in that list is simply never asked for.
- **Accepted extensions:** `.webp`, `.png`, `.jpg`, `.jpeg`, `.avif`. If two
  files share a name with different extensions, which one wins is undefined —
  keep one per name.
- **Square, 256×256 or larger.** The art is drawn at 32–120 CSS px depending on
  the screen, on displays that are often 2×, so 256 is the floor. It is masked
  into a circle, so keep the subject centred and leave a little margin.
- **WebP, under ~40 KB each.** Everything here ships inside the installer and
  must work with no internet. 27 pictures at 40 KB is about 1 MB — fine. A
  folder of 500 KB photos is not.
- **It must read at 40 px.** One subject, high contrast, no fine detail and no
  text in the picture. The words beside it carry the meaning; the picture is
  recognition, not explanation.
- **Works on every theme.** A raster picture cannot follow the theme the way
  the SVGs do, so avoid art that only reads on one background. Check it on
  Light, Violet and Sea before committing.

## Doing it one at a time

Any name with no file here keeps its line drawing, so the set can be replaced
picture by picture. To back a picture out, delete the file.

## Checking your work

```bash
npm run dev:friendly
```

The home menu shows most of the set; sign-in, open/close shift and the checkout
cover the rest. `npx vitest --run tests/friendly-ui.test.tsx` asserts the
fallback still holds.
