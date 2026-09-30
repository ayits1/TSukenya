#!/usr/bin/env python3
"""Validate a CSV export of the Google Sheets 'Товари' tab before import."""

import argparse
import csv
from collections import Counter
from pathlib import Path


REQUIRED = ("Назва", "Група", "Категорія", "Пакування", "Од.", "ID")
NUMERIC = ("Закупівля, грн", "Націнка, %", "Ціна продажу, грн")


def number(value: str) -> float | None:
    value = value.replace("\u00a0", "").replace(" ", "").replace(",", ".").strip()
    if not value:
        return None
    return float(value)


def validate(path: Path) -> int:
    with path.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    if not rows:
        raise ValueError("Експорт не містить товарів")
    missing = [name for name in REQUIRED + NUMERIC if name not in rows[0]]
    if missing:
        raise ValueError("Немає стовпців: " + ", ".join(missing))

    products = [row for row in rows if row["Назва"].strip()]
    errors: list[str] = []
    ids = [row["ID"].strip() for row in products]
    duplicates = [item for item, count in Counter(ids).items() if item and count > 1]
    if duplicates:
        errors.append(f"Повторюються ID ({len(duplicates)})")
    if any(not item for item in ids):
        errors.append("Є товари без ID")

    no_price = 0
    for index, row in enumerate(products, start=2):
        parsed = {}
        for field in NUMERIC:
            try:
                parsed[field] = number(row[field])
            except ValueError:
                errors.append(f"Рядок {index}: некоректне число у «{field}»")
        if any(value is not None and value < 0 for value in parsed.values()):
            errors.append(f"Рядок {index}: від'ємна ціна, закупівля або націнка")
        if parsed.get("Ціна продажу, грн") is None and not parsed.get("Закупівля, грн"):
            no_price += 1

    print(f"Заповнених товарів: {len(products)}")
    print(f"Унікальних ID: {len(set(ids))}")
    print(f"Без ручної ціни та закупівлі: {no_price}")
    if errors:
        raise ValueError("; ".join(errors))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    args = parser.parse_args()
    raise SystemExit(validate(args.csv_path))
