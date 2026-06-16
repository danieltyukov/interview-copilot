"""Sparky brand-asset generator.

Single source of truth for the Sparky mascot — a one-colour yellow pixel-budgie
(black eyes only, like the Claude mascot). Emits the app icon and the README hero
SVG from one ASCII map, so every size is reproducible:

    python tools/sparky_assets.py          # writes the SVGs
    # then rasterise (needs inkscape):
    inkscape extension/icons/icon.svg --export-type=png \
        --export-filename=extension/icons/icon128.png -w 128

Run tools/render_sparky.sh to regenerate every PNG at once.
"""
from pathlib import Path

YELLOW = "#FFC61A"   # the one body colour
EYE = "#1A1A1A"      # eyes — the only second colour, as in the reference
CREAM = "#F4F1E8"    # icon tile background

# 16x16 single-colour budgie. 'Y' = body, 'K' = eye, '.' = empty. Budgie-ness is
# carried by the crest tuft + chunky body + two feet — no second colour needed.
SPARKY = [
    "................",
    ".......YY.......",
    "......YYYY......",
    "....YYYYYYYY....",
    "...YYYYYYYYYY...",
    "..YYYYYYYYYYYY..",
    "..YYKKYYYYKKYY..",
    "..YYKKYYYYKKYY..",
    "..YYYYYYYYYYYY..",
    "..YYYYYYYYYYYY..",
    "..YYYYYYYYYYYY..",
    "...YYYYYYYYYY...",
    "...YYYYYYYYYY...",
    "....YYYYYYYY....",
    "....YY....YY....",
    "................",
]
COLS = {"Y": YELLOW, "K": EYE, ".": None}
N = len(SPARKY)


def sparky_group(x0, y0, cell):
    """Pixel <rect>s for Sparky. Cells overlap by 0.6px to kill antialiased seams."""
    ov = 0.6
    out = []
    for r, row in enumerate(SPARKY):
        for c, ch in enumerate(row):
            col = COLS[ch]
            if not col:
                continue
            x = x0 + c * cell
            y = y0 + r * cell
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{cell+ov:.1f}" '
                       f'height="{cell+ov:.1f}" fill="{col}"/>')
    return "\n  ".join(out)


def write_icon(path):
    """App icon: yellow Sparky mascot only, on a transparent background."""
    size = 128
    cell = 7
    grid = N * cell
    off = (size - grid) / 2
    svg = f'''<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}" \
xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  {sparky_group(off, off, cell)}
</svg>
'''
    Path(path).write_text(svg)


def write_logo(path):
    """README hero banner: dark frame, Sparky mascot, speech bubble, wordmark, chips."""
    cell = 12
    mascot = sparky_group(78, 86, cell)
    svg = f'''<svg width="1100" height="380" viewBox="0 0 1100 380" \
xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1117"/><stop offset="1" stop-color="#161b22"/>
    </linearGradient>
  </defs>
  <rect width="1100" height="380" rx="32" fill="url(#bg)"/>
  <rect x="2" y="2" width="1096" height="376" rx="31" fill="none" stroke="#21262d" stroke-width="3"/>
  <circle cx="38" cy="38" r="7.5" fill="#ff5f56"/>
  <circle cx="63" cy="38" r="7.5" fill="#ffbd2e"/>
  <circle cx="88" cy="38" r="7.5" fill="#27c93f"/>

  <!-- ===== Sparky (single-colour pixel budgie) ===== -->
  {mascot}

  <!-- speech bubble -->
  <g transform="translate(322,70)" font-family="DejaVu Sans Mono, monospace">
    <rect x="0" y="0" width="262" height="72" rx="16" fill="#1f2937" stroke="{YELLOW}" stroke-width="2.5"/>
    <path d="M26 72 l -18 30 l 42 -30 z" fill="#1f2937"/>
    <path d="M26 72 l -18 30 l 42 -30" fill="none" stroke="{YELLOW}" stroke-width="2.5"/>
    <text x="22" y="33" font-size="19" fill="#fde68a">psst&#8230; press</text>
    <text x="22" y="57" font-size="19" font-weight="bold" fill="{YELLOW}">h &#8212; i got you</text>
  </g>

  <!-- wordmark -->
  <text x="404" y="214" font-family="DejaVu Sans, Verdana, sans-serif" font-weight="bold" font-size="62" fill="#e6edf3">Sparky</text>
  <text x="406" y="252" font-family="DejaVu Sans Mono, monospace" font-size="18" fill="#9aa4b0">your interview copilot &#183; reads your repo &#183; whispers the answer</text>

  <g transform="translate(406,276)" font-family="DejaVu Sans Mono, monospace">
    <rect x="0" y="0" width="140" height="40" rx="9" fill="#161b22" stroke="#30363d" stroke-width="2"/>
    <circle cx="22" cy="20" r="6" fill="#34d399"/>
    <text x="38" y="27" font-size="17" fill="#9fb0c0">deepgram</text>
  </g>
  <g transform="translate(560,276)" font-family="DejaVu Sans Mono, monospace">
    <rect x="0" y="0" width="200" height="40" rx="9" fill="#161b22" stroke="#30363d" stroke-width="2"/>
    <circle cx="22" cy="20" r="6" fill="{YELLOW}"/>
    <text x="38" y="27" font-size="17" fill="#9fb0c0">claude api+cli</text>
  </g>
</svg>
'''
    Path(path).write_text(svg)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    write_icon(root / "extension/icons/icon.svg")
    write_logo(root / "docs/logo.svg")
    print("wrote extension/icons/icon.svg and docs/logo.svg")
