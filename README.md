# Cross Stitch Helper

A phone-friendly web app (PWA) for keeping track of a cross stitch project.

1. **Import** a photo or screenshot of a chart. The app finds the grid, reads the colour of every square and rebuilds the pattern. You get two quick steps: line up the grid, then check the colours (with a one-tap **Pattern / Original** toggle to compare against your image).
   If the chart has a legend, the app finds its colour swatches and matches every square to them, so the number of colours starts out right. The count is a number field you can nudge up and down; changing it switches to automatic grouping.
2. **Fix squares**: a side-by-side (or stacked) editor shows the rebuilt pattern and your original chart with one shared zoom and position. Paint, pick a colour from a square, flood-fill, merge or recolour palette colours. Open it from the import review or from the stitching screen (*Fix squares*).
3. **Stitch**: pinch to zoom, tap (or swipe) squares to mark them done. Finished squares fill in with full colour and a tick; unfinished ones stay pale with a symbol.
4. **Highlight a colour**: tap a swatch in the tray to make every *unfinished* square of that colour stand out (with a count of how many are left).
5. **Original toggle** at the top of the stitching screen flips to your original chart at exactly the same zoom and position, with your progress shown on top.

The screen stays awake while you stitch (Screen Wake Lock API). Progress is saved on the phone (IndexedDB); the app works offline once loaded. Use *Pattern options → Save a backup file* to export a pattern with its progress.

## Develop

```sh
npm install
npm run dev      # http://localhost:5173, reachable from your phone on the same network
npm test         # unit tests for grid detection / colour clustering (uses test/fixtures/macaw.png)
npm run build
```

Wake Lock, the service worker and "install to home screen" need HTTPS (or localhost), so test on a real phone through the deployed site.

## Deploy to your phone (GitHub Pages)

Merge to `main`, then in the repo go to **Settings → Pages → Source: GitHub Actions**. The workflow in `.github/workflows/deploy.yml` builds and publishes the site; open the URL in Chrome on Android and choose **Add to Home screen**.

## How import works

- `src/core/detect.ts` finds the grid spacing and offset from the faint repeating lines (Fourier scan of the line profile).
- If the grid isn't found (or is wrong), the first import step lets you drag the two corners around the chart and press **Find grid here**, which re-runs detection on just that area. **Mark one square** (draw a box around a single square) and the Columns/Rows counts are used as size hints. Charts with no grid lines at all are handled by looking at the edges between coloured squares.
- Whole-page charts (several designs, several legends, symbols instead of colours) are handled by:
  - `src/core/shading.ts`: a translucent dark band across the top of a screenshot (a PDF viewer toolbar shadow) is detected and brightened away before analysis.
  - `src/core/lines.ts` / `gridmask.ts`: every grid line is located exactly (the heavy every-tenth lines are kept out of the squares), and cells without grid lines (legend boxes, captions, margins) are ignored.
  - `src/core/legend.ts`: finds every legend swatch, including stacks of touching ones, across several legends, reading colour and symbol shape.
  - `src/core/appearance.ts`: a stitch is its fill colour *and* its symbol; the symbol is reduced to a few shape numbers that survive small shifts. Colours the legend scan missed are added when a real share of the chart goes unexplained; without a legend, stitches are clustered by appearance.
- `src/core/sample.ts` takes the dominant colour of each square, ignoring dark symbols and backstitch lines; a dark mark in the middle of a white square is treated as a white stitch.
- `src/core/quantize.ts` clusters colours (agglomerative, in Lab space) so the "number of colours" slider is instant.
- `src/core/legend.ts` finds the legend: same-sized swatches lined up in a column or row, reading each swatch's colour.
- `src/core/model.ts` ties it together and offers clean-up for legends/labels that sit next to the chart.

Backstitch lines are not imported yet; keep an eye on them via the Original toggle.
