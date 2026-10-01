"""Génère les icônes de l'app (chronomètre) dans web/icons/. Usage : py tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
BG = (19, 19, 22)
FACE = (241, 241, 243)
ACCENT = (232, 150, 74)
SS = 4  # suréchantillonnage pour des bords nets


def draw(size, scale):
    """Chronomètre centré ; `scale` = part du côté occupée (plus petit pour l'icône masquable)."""
    n = size * SS
    img = Image.new("RGB", (n, n), BG)
    d = ImageDraw.Draw(img)
    c = n / 2
    r = n * scale / 2
    cy = c + r * 0.08
    w = r * 0.13

    # bouton du haut
    d.rounded_rectangle([c - r * 0.16, cy - r * 1.18, c + r * 0.16, cy - r * 0.98], radius=r * 0.05, fill=FACE)
    d.rectangle([c - r * 0.06, cy - r * 1.0, c + r * 0.06, cy - r * 0.86], fill=FACE)
    # cadran
    d.ellipse([c - r * 0.86, cy - r * 0.86, c + r * 0.86, cy + r * 0.86], outline=FACE, width=int(w))
    # secteur écoulé
    inner = r * 0.62
    d.pieslice([c - inner, cy - inner, c + inner, cy + inner], start=-90, end=40, fill=ACCENT)
    # aiguille
    d.line([c, cy, c, cy - inner], fill=FACE, width=int(w * 0.8))
    d.ellipse([c - w, cy - w, c + w, cy + w], fill=FACE)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192, 0.78).save(OUT / "icon-192.png")
    draw(512, 0.78).save(OUT / "icon-512.png")
    draw(512, 0.58).save(OUT / "icon-maskable-512.png")
    draw(180, 0.72).save(OUT / "apple-touch-icon.png")
    print("Icônes écrites dans", OUT)


if __name__ == "__main__":
    main()
