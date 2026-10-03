"""Versioned CSV decoding only. Decimal/accounting validation remains in services."""
import csv
import io
import re
import unicodedata

from .services import BusinessError

MARKER = ' [TSukenya CSV 1]'


def guarded(value):
    if value.startswith(('\t', '\r', '\n')):
        return True
    for char in value:
        if char.isspace() or unicodedata.category(char) in {'Cf', 'Cc'}:
            continue
        return char in '=+@-＝＋－＠'
    return False


def delimiter(text):
    quoted = False
    commas = semicolons = 0
    i = 0
    while i < len(text):
        char = text[i]
        if char == '"':
            if quoted and i + 1 < len(text) and text[i + 1] == '"':
                i += 1
            else:
                quoted = not quoted
        elif not quoted:
            if char in '\r\n':
                break
            commas += char == ','
            semicolons += char == ';'
        i += 1
    return ';' if semicolons > commas else ','


def read_rows(text):
    """Keep actual source line numbers and remove only declared TSukenya escaping."""
    source = text.removeprefix('\ufeff')
    reader = csv.reader(io.StringIO(source, newline=''), delimiter=delimiter(source), strict=True)
    try:
        headers = next(reader, [])
        own = bool(headers and headers[0].endswith(MARKER))
        if headers and re.search(r' \[TSukenya CSV \d+\]$', headers[0]) and not own:
            raise BusinessError('Версія CSV TSukenya не підтримується. Оновіть застосунок.')
        if own:
            headers[0] = headers[0][:-len(MARKER)]
        def decode(value):
            return value[1:] if own and value.startswith('\t') and guarded(value[1:]) else value
        headers = [decode(value) for value in headers]
        if len(headers) != len(set(headers)):
            raise BusinessError('CSV містить повторні заголовки стовпців.')
        rows = []
        line = reader.line_num + 1
        for values in reader:
            current = line
            line = reader.line_num + 1
            if not values or not any(values):
                continue
            if len(values) != len(headers):
                raise BusinessError(f'Рядок {current}: кількість полів не відповідає заголовку.')
            rows.append((current, dict(zip(headers, map(decode, values)))))
        return headers, rows
    except csv.Error as error:
        raise BusinessError('Некоректні лапки або рядки у CSV. Перевірте файл.') from error
