# DrewKraken regression: before (main at 2d54116)

| Measure | Result |
|---|---|
| Documents with every key header field right | 59.1% (107 of 181) |
| Key header fields right | 81.6% (1286 of 1576) |
| Line items, mean F1 | 0.725 (179 documents; all lines right on 116) |
| Invoices whose figures do not add up, flagged | 5 of 5 |
| Files holding several invoices, flagged | 2 of 2 |
| Consistent documents flagged (false alarms) | 14 of 172 |

## Fields

| Field | Right | Scored | % |
|---|---|---|---|
| vendor_name | 155 | 181 | 85.6 |
| invoice_number | 135 | 179 | 75.4 |
| invoice_date | 149 | 179 | 83.2 |
| due_date | 105 | 140 | 75 |
| currency | 153 | 179 | 85.5 |
| subtotal | 140 | 179 | 78.2 |
| tax | 139 | 179 | 77.7 |
| total | 141 | 179 | 78.8 |
| document_type | 169 | 181 | 93.4 |
| line_items | 116 | 179 | 64.8 |
| flag | 165 | 179 | 92.2 |
| references | 0 | 25 | 0 |

## By category

| Category | Documents | Fully correct | % |
|---|---|---|---|
| clean | 31 | 30 | 96.8 |
| currency | 19 | 13 | 68.4 |
| tax | 14 | 14 | 100 |
| credit | 10 | 0 | 0 |
| multipage | 10 | 7 | 70 |
| freight | 16 | 16 | 100 |
| scan | 15 | 6 | 40 |
| photo | 45 | 11 | 24.4 |
| handwritten | 8 | 0 | 0 |
| hard | 13 | 10 | 76.9 |

## By difficulty

| Difficulty | Documents | Fully correct | % |
|---|---|---|---|
| easy | 62 | 49 | 79 |
| medium | 48 | 26 | 54.2 |
| hard | 71 | 32 | 45.1 |

## By photo/scan severity

| Photo/scan severity | Documents | Fully correct | % |
|---|---|---|---|
| mild | 20 | 11 | 55 |
| moderate | 20 | 4 | 20 |
| severe | 20 | 2 | 10 |
