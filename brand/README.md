# Máddu logo — first-pass vector assets

This package contains five black-on-white concept silhouettes plus one refined direction: **Spine Seal**.

## Refined direction: Spine Seal

The mark is a filled lozenge segmented by two angular negative-space ledger cuts. It combines three brief themes:

- **seal / boundary**: a closed lozenge that feels witnessed and device-bound;
- **root / origin**: the lower point of the lozenge acts as a taproot / anchor;
- **spine / lineage**: the cuts turn the seal into stacked vertebrae or recorded generations.

It avoids circles, mascots, neural meshes, friendly gradients, and culturally specific Sámi marks.

## Palette used

- Navy noir: `#050B17`
- Cream ink: `#F5F1E8`
- Brand orange: `#F04E23`
- Black: `#000000`
- White: `#FFFFFF`

The proposed default is **orange mark + cream wordmark on navy**. The mark also works as pure black on white and pure white on black.

## Typography

SVG lockups reference:

`IBM Plex Sans Condensed`, weight `600`, letter spacing `-0.01em` for `Máddu`.

The tagline uses `IBM Plex Mono` with small tracking. The font files are not included.

## Recommended usage

- Minimum icon size: 16px. At 16px, use the icon-only favicon version; avoid the wordmark.
- Clear space: at least one half of the icon width around the mark.
- Horizontal rail header: use `refined/maddu-horizontal-240x40-dark.svg`.
- GitHub/social avatar: use `refined/maddu-avatar-icon-200x200-dark.svg` or the icon-only mark.
- README light mode: use `refined/maddu-horizontal-240x40-light.svg` or `refined/maddu-mark-black.svg`.
- Foil / print / stamp: use `refined/maddu-mark-currentcolor.svg` and set the single output color in the production file.

## Do not

- Flatten the acute accent in `Máddu`.
- Add glows, gradients, bevels, or drop shadows.
- Round the geometry.
- Recolor outside the palette without testing contrast.
- Use the tagline below 80px horizontal lockup height.

## Files

- `concepts/`: five concept directions as SVG + 64px and 240px PNG tests.
- `refined/`: primary SVG lockups and PNG fallbacks at @1x, @2x, @3x.
- `favicons/`: 16, 32, 64, 128px favicon PNGs and `.ico`.
- `preview/`: visual boards for review.

These are first-pass design proposals, not final production identity files.
