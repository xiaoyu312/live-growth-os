# Social sharing image

`social-preview.png` is a 1280 × 640 social sharing image for **Live Growth OS**. It is not a README cover or a product screenshot. Adding these files to the repository does **not** automatically set GitHub's Social preview image; that setting is a separate action.

The artwork uses original abstract geometry and the author's cream, cobalt, navy and orange palette. No third-party source images are used; existing repository and upstream license scopes remain unchanged. The copy describes the experimental source edition for livestream context and evidence-backed recommendations requiring human confirmation; no business outcome or full platform validation is claimed. The original motif uses separate context nodes converging on a central geometric decision shape. It makes no claim of production readiness.

## Files and regeneration

- `social-preview.svg`: editable vector source; text and shapes remain editable.
- `social-preview.png`: rendered RGB image, exactly 1280 × 640 and strictly below 1,000,000 bytes.
- `generate.py`: local renderer and size / text-safe-area checks. It uses only this directory's SVG and writes this directory's PNG.

With Python 3, PyMuPDF (`fitz`) and Pillow already available, run from the repository root:

```sh
python3 assets/social/generate.py
```

PyMuPDF and Pillow are optional local rendering tools, not bundled dependencies of the application or assets. Their own upstream licenses apply; the project license does not relicense either tool. No system font files are bundled.

The script does not download dependencies, fonts or assets and does not access the network. It uses the renderer's built-in sans-serif font for the PNG; the SVG declares Arial for normal viewing. Keep key text inside the 64-pixel safe area when editing. There are no photos, third-party characters, business records, tracking links or simulated product screens.

Author: [xiaoyu312](https://github.com/xiaoyu312). More projects: [FateClear](https://fateclear.com) and [X](https://x.com/liu_xiaoyu27334).
