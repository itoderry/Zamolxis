---
name: canvas
description: Show rich visuals to the user with the show_canvas tool - charts, tables, dashboards, diagrams, galleries, forms, calculators. The Canvas window opens automatically on the user's desktop. Prefer this over describing a visualization in words.
---

# Canvas (show_canvas)

When the answer is better SEEN than read, call `show_canvas` with a complete, self-contained HTML document. It renders in a sandboxed iframe in the user's desktop Canvas window (which opens/raises automatically).

Good uses: bar/line/pie charts, data tables, comparison grids, dashboards, timelines, diagrams/flowcharts, image galleries, interactive forms or calculators, rendered previews.

Tips:
- Send ONE full document: include any <style> and <script> inline; no external build step.
- Charts: either hand-draw with SVG/CSS, or pull a CDN lib (e.g. Chart.js) via <script src>.
- Keep it readable on white; the iframe has no app styling.
- The iframe is sandboxed (scripts run, but no access to the page, cookies, or same-origin) - don't rely on network calls that need credentials.
- After showing, briefly say in chat what you displayed.
