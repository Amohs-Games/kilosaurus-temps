"""Génère toutes les icônes (web et Android) depuis kilo_logo.png. Usage : py tools/make_icons.py"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "kilo_logo.png"
WEB = ROOT / "web" / "icons"
ANDROID = ROOT / "android" / "res"


def square(logo, size):
    return logo.resize((size, size), Image.LANCZOS)


def padded(logo, size, ratio):
    """Logo réduit à `ratio` du côté, centré sur sa couleur de fond (icône masquable)."""
    bg = logo.getpixel((2, 2))
    canvas = Image.new("RGB", (size, size), bg)
    inner = int(size * ratio)
    canvas.paste(logo.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return canvas


def main():
    logo = Image.open(LOGO).convert("RGB")
    WEB.mkdir(parents=True, exist_ok=True)
    square(logo, 192).save(WEB / "icon-192.png")
    square(logo, 512).save(WEB / "icon-512.png")
    square(logo, 180).save(WEB / "apple-touch-icon.png")
    padded(logo, 512, 0.8).save(WEB / "icon-maskable-512.png")
    square(logo, 144).save(ANDROID / "mipmap-xxhdpi" / "ic_launcher.png")
    square(logo, 192).save(ANDROID / "mipmap-xxxhdpi" / "ic_launcher.png")
    print("Icônes écrites dans", WEB, "et", ANDROID)


if __name__ == "__main__":
    main()
