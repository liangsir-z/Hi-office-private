---
name: slide-design-master
description: Professional slide design system for creating and beautifying slides — typography scale, color dominance rules, anti-AI-look prohibitions, whitespace discipline, and per-page-type recipes. Apply whenever designing, redesigning, or beautifying a slide.
when_to_use: Any time you compose or restyle a slide — regenerate_slide HTML, beautify requests, or new page layouts. Follow this system instead of improvising.
app: slides
license: Apache-2.0 (adapted from anthropics/skills pptx design guidance and community design guides)
---

# Slide Design System

You are designing slides for a professional audience. Follow this system exactly; it replaces personal improvisation.

## Typography scale (use exactly these rungs)

- Page title: 36–44pt bold (≈ 48–59px)
- Section heading: 20–24pt semibold (≈ 27–32px)
- Body: 14–16pt (≈ 19–21px)
- Caption/note: 10–12pt (≈ 13–16px)
- Hero number (KPI): 60–72pt bold (≈ 80–96px)

Body text is left-aligned. Only titles on cover/closing pages may center. Never more than these rungs on one page.

## Color: dominance over equality

- ONE dominant color covers 60–70% of the page (usually the background: white, near-white #F7F8FA, or a deep neutral).
- ONE accent color, used sparingly (headline keyword, hero number, icon, chip). Never two accent colors.
- Text: near-black #1A1D24 on light; white on dark. Contrast ≥ 4.5:1 always.
- Do NOT default to blue. Pick the palette to match the topic; keep the deck's existing palette when restyling.

Palettes (background + accent + dark text):
- Deep Teal Business: #F7F8FA / #0F766E / #134E4A
- Warm Terracotta: #FBF8F5 / #C2410C / #3F2A20
- Forest Calm: #F6F8F4 / #3F6212 / #1F2A1B
- Graphite Premium: #1C1E26 dark bg / #E8B93E accent / #F4F5F8 text
- Ocean Depth: #0B1F33 dark bg / #38BDF8 accent / #F0F6FC text

## Anti-AI-look prohibitions (hard bans)

These are recognized tells of AI-generated slides. NEVER use them:
- NO decorative line/bar under or beside titles.
- NO header bars, footer bars, vertical sidebar stripes, or single-side color borders.
- NO beige/cream backgrounds by default.
- NO page that is only a title + bullet list — every page needs a visual element: a large number, a color-block composition, a diagram, a chart, or generous typographic composition.
- NO rainbow of box colors; NO thin outlines around every box.

## Whitespace & alignment

- Canvas margins ≥ 48px on all sides; content block gaps consistent and ≥ 24px.
- Leave 40–50% of the page empty. When in doubt, remove elements instead of shrinking fonts.
- Align to a grid: shared left edge for text columns; consistent card widths.
- 6×6 rule: at most 6 bullets of ≤ 6 words each — 3–4 bullets is better. Shorten wording rather than shrinking fonts.

## Visual motif

Pick ONE recurring element for the whole deck and reuse it on every page — e.g. rounded-corner cards, circular numbered chips, or oversized section numerals in a tint of the accent color. Never use a color bar as the motif.

## Per-page-type recipes

- **Cover**: full-bleed dominant background; title 44pt+; one accent element (large tinted shape or numeral); ≤ 20 words total.
- **Content**: title top-left; ONE message per page; visual element occupies ≥ 40% of the area (color-block composition, image, or diagram); body supports, never crowds.
- **Data/KPI**: the figure dominates — hero number 60pt+ in accent; one line of conclusion; at most 3 supporting figures as small labeled stats.
- **Comparison**: two balanced panels sharing one geometry; contrast via background tint of the SAME hue, not different hues.
- **Closing**: echo the cover; ≤ 15 words; contact/footer only.

## HTML authoring notes (for the HTML conversion route)

- One `<div class="slide">` 1280×720; system font stack; solid fills only (no gradients/shadows/transforms).
- Prefer flex/grid with real gaps; text elements should wrap their own text (the converter measures actual glyphs).
- Emphasize with size/weight/color — never with decorative borders or bars.
