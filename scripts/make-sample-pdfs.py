import json
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
for kind in ['invoice','po']:
 d=json.load(open('dist/samples/matching-'+kind+'.json'))
 c=canvas.Canvas('dist/samples/matching-'+kind+'.pdf',pagesize=(612,792))
 c.setFillColor(HexColor('#153e33'));c.rect(0,690,612,102,fill=1,stroke=0);c.setFillColor(HexColor('#ffffff'));c.setFont('Helvetica-Bold',26);c.drawString(42,738,'INVOICE' if kind=='invoice' else 'PURCHASE ORDER')
 c.setFont('Helvetica',11);c.drawString(42,712,'Oak & Elm Creative - fictional training document')
 c.setFillColor(HexColor('#22352a'));y=650
 lines=['Vendor: '+d['vendor'],('Invoice: ' if kind=='invoice' else 'Purchase order: ')+d['number'],'PO reference: '+d['poNumber'],'Currency: USD','','SKU / Description / Quantity / Unit price / Amount','']
 for l in d['lines']:lines.append(f"{l['sku']}  {l['description']}  {l['quantity']}  {l['unitPrice']:.2f}  {l['quantity']*l['unitPrice']:.2f}")
 lines+=['',f"Tax: {d['tax']:.2f}",f"Total: {d['total']:.2f}",'','DEMO ONLY. No payment is due.']
 for line in lines:c.setFont('Helvetica',11);c.drawString(42,y,line);y-=27
 c.save()
