"""Construit Kilosaurus_Temps.xlsx à partir de l'onglet Formulaire de l'ancien fichier.

Usage : py tools/migrate.py [ancien.xlsx] [nouveau.xlsx]

Seules les lignes des personnes de PERSONS sont reprises ; celles des autres sont comptées, sans
être nommées. Le script relit le fichier produit et échoue si les heures reprises ne correspondent
pas à celles de l'ancien fichier : un report qui perd ou double des heures ne doit jamais sortir.
"""
import sys
from collections import defaultdict
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

OLD = sys.argv[1] if len(sys.argv) > 1 else "Kilosaurus Timesheet.xlsx"
NEW = sys.argv[2] if len(sys.argv) > 2 else "Kilosaurus_Temps.xlsx"

HEADERS = ["ID", "Personne", "Date", "Début", "Fin", "Heures", "Note", "Source", "Saisi le", "Corrigé", "Modifié le"]
WIDTHS = [22, 12, 12, 17, 17, 9, 40, 11, 19, 9, 19]
FORMATS = {3: "dd/mm/yyyy", 4: "dd/mm/yyyy hh:mm", 5: "dd/mm/yyyy hh:mm", 6: "0.00", 9: "dd/mm/yyyy hh:mm:ss", 11: "dd/mm/yyyy hh:mm:ss"}

PROJECTS = {"Fluffy": "Fluffy", "Compta/Gestion": "Studio"}
PERSONS = {"Honoré": "Amohs"}

HEADER_FONT = Font(name="Arial", bold=True, color="FFFFFF")
HEADER_FILL = PatternFill("solid", fgColor="333333")
BODY_FONT = Font(name="Arial")


def style_header(ws, headers, widths):
    for i, (title, width) in enumerate(zip(headers, widths), start=1):
        cell = ws.cell(row=1, column=i, value=title)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"


def project_sheet(wb, name):
    ws = wb.create_sheet(name)
    style_header(ws, HEADERS, WIDTHS)
    for col, fmt in FORMATS.items():
        for row in range(2, 1001):
            ws.cell(row=row, column=col).number_format = fmt
    return ws


def read_old(path):
    ws = openpyxl.load_workbook(path, data_only=True)["Formulaire"]
    rows, skipped, others = [], [], 0
    for r in range(2, ws.max_row + 1):
        stamp, _, day, hours, project, task, person = (ws.cell(r, c).value for c in range(1, 8))
        if day is None and hours is None:
            continue
        if person not in PERSONS:
            others += 1
            continue
        if not isinstance(hours, (int, float)) or not isinstance(day, datetime):
            skipped.append((r, person, day, hours))
            continue
        if project not in PROJECTS:
            raise SystemExit(f"Ligne {r} : projet inconnu {project!r}")
        rows.append({
            "person": PERSONS[person],
            "project": PROJECTS[project],
            "date": day,
            "hours": float(hours),
            "note": (task or "").strip(),
            "created": stamp if isinstance(stamp, datetime) else None,
            "old_row": r,
        })
    return rows, skipped, others


def build(rows, path):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    sheets = {name: project_sheet(wb, name) for name in ("Fluffy", "Studio")}

    rows = sorted(rows, key=lambda x: (x["date"], x["person"], x["old_row"]))
    next_row = defaultdict(lambda: 2)
    for n, x in enumerate(rows, start=1):
        ws = sheets[x["project"]]
        r = next_row[x["project"]]
        next_row[x["project"]] += 1
        values = [f"report-{n:04d}", x["person"], x["date"], None, None, x["hours"],
                  x["note"], "report", x["created"], None, None]
        for c, v in enumerate(values, start=1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = BODY_FONT

    cfg = wb.create_sheet("_Config")
    style_header(cfg, ["Personnes", "", "Paramètre", "Valeur"], [16, 4, 22, 12])
    for i, name in enumerate(sorted(set(PERSONS.values())), start=2):
        cfg.cell(row=i, column=1, value=name)
    for i, (key, value) in enumerate([("Seuil oubli (h)", 8), ("Onglet studio", "Studio"),
                                       ("Boutons visibles", 4)], start=2):
        cfg.cell(row=i, column=3, value=key)
        cfg.cell(row=i, column=4, value=value)

    corr = wb.create_sheet("_Corrections")
    style_header(corr, ["Horodatage", "Auteur", "Source", "Projet", "ID", "Champ",
                        "Ancienne valeur", "Nouvelle valeur"], [19, 12, 11, 14, 22, 12, 19, 19])
    for row in range(2, 1001):
        corr.cell(row=row, column=1).number_format = "dd/mm/yyyy hh:mm:ss"

    project_sheet(wb, "_Modèle")
    wb.save(path)


def totals(rows):
    t = defaultdict(float)
    for x in rows:
        t[x["person"]] += x["hours"]
    return dict(t)


def read_new(path):
    wb = openpyxl.load_workbook(path)
    t = defaultdict(float)
    count = 0
    for ws in wb.worksheets:
        if ws.title.startswith("_"):
            continue
        for r in range(2, ws.max_row + 1):
            person, hours = ws.cell(r, 2).value, ws.cell(r, 6).value
            if person:
                t[person] += hours
                count += 1
    return dict(t), count


def main():
    rows, skipped, others = read_old(OLD)
    build(rows, NEW)
    expected = totals(rows)
    got, count = read_new(NEW)

    print(f"{count} lignes reportées dans {NEW} ({others} lignes d'autres personnes ignorées)")
    for r, person, day, hours in skipped:
        print(f"  écartée : ligne {r} de l'ancien Formulaire ({person}, {day}, durée {hours!r})")
    for person in sorted(expected):
        print(f"  {person:8} {expected[person]:8.1f} h  →  {got.get(person, 0):8.1f} h")

    if count != len(rows) or any(abs(expected[p] - got.get(p, 0)) > 1e-6 for p in expected):
        raise SystemExit("ÉCHEC : les heures reportées ne correspondent pas à l'ancien fichier.")
    print("OK : totaux identiques.")


if __name__ == "__main__":
    main()
