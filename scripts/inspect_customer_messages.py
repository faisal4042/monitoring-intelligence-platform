import json
import sys
from pathlib import Path

import pandas as pd


sys.stdout.reconfigure(encoding="utf-8")

source = Path(sys.argv[1])
book = pd.ExcelFile(source)
summary = []

for sheet_name in book.sheet_names:
    frame = pd.read_excel(source, sheet_name=sheet_name)
    summary.append(
        {
            "sheet": sheet_name,
            "rows": len(frame),
            "columns": [str(column) for column in frame.columns],
            "non_null": {
                str(column): int(frame[column].notna().sum()) for column in frame.columns
            },
            "samples": {
                str(column): [str(value)[:500] for value in frame[column].dropna().head(5)]
                for column in frame.columns
            },
        }
    )

print(json.dumps(summary, ensure_ascii=False, indent=2))
