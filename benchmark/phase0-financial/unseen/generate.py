"""Render the synthetic evaluation pack. Requires reportlab, PyMuPDF and Pillow."""
from decimal import Decimal, ROUND_HALF_UP
from io import BytesIO
from pathlib import Path
import json
import fitz
from PIL import Image, ImageEnhance, ImageFilter
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parent
DOCS = ROOT / 'documents'
DOCS.mkdir(exist_ok=True)
SCENARIOS = ['plain', 'rate-first', 'header-lost', 'tax-rate', 'split-tax', 'adjustments',
             'wrapped', 'two-currencies', 'wrong-subtotal', 'wrong-total', 'credit',
             'missing-number', 'pair-invoice', 'pair-order', 'partial-base', 'no-tax']
CENT = Decimal('.01')
def money(v):
    return v.quantize(CENT, rounding=ROUND_HALF_UP)

def render(index):
    scenario = SCENARIOS[index % len(SCENARIOS)]
    batch = index // len(SCENARIOS)
    group = index - (scenario == 'pair-order')
    order = scenario == 'pair-order'
    credit = scenario == 'credit'
    ref = ('CM' if credit else 'PO' if order else 'IV') + f'-{4100 + group}'
    po = f'PO-{4100 + group}'
    supplier = ['Plover Hill Studio', 'Cairn Office Supply', 'Mesa Sign Works'][batch]
    currency = ['USD','GBP','EUR'][batch]
    quantity = 2 + group % 7
    price = Decimal(11 + group % 23) + (Decimal('.75') if scenario != 'header-lost' and index % 2 else 0)
    first = money(quantity * price)
    second = Decimal(12 + batch)
    amounts = [first,second]
    subtotal = sum(amounts) + (3 if scenario == 'wrong-subtotal' else 0)
    rate = Decimal('7.5')
    tax = money(subtotal * rate / 100)
    if scenario == 'partial-base':
        tax = money(first * rate / 100)
    if scenario == 'split-tax':
        tax = money(first * Decimal('.05')) + money(second * Decimal('.10'))
    if scenario == 'no-tax':
        tax = Decimal('0')
    total = subtotal + tax + (2 if scenario == 'wrong-total' else 0) + (4 if scenario == 'adjustments' else 0)
    buffer = BytesIO()
    canvas = Canvas(buffer, pagesize=(610,500), invariant=True, pageCompression=1)
    def write(x,y,s,size=11):
        canvas.setFont('Helvetica',size)
        canvas.drawString(x,500-y,str(s))
    title = 'Credit Note' if credit else 'Purchase Order' if order else 'Invoice'
    write(35,40,title,18)
    write(35,65,'Supplier: '+supplier)
    if scenario != 'missing-number':
        write(35,83,('Document Number: ' if not order else 'PO Number: ')+ref)
    if scenario == 'pair-invoice': write(315,83,'PO Number: '+po)
    write(35,102,'Currency: '+currency)
    write(35,120,'Issue Date: 2031-08-17')
    reverse = scenario in ['rate-first','header-lost','pair-invoice'] or (batch==1 and not order)
    labels = ['SKU','Description','Rate' if reverse else 'Qty','Qty' if reverse else 'Unit Price','Amount']
    xs = [35,116,355,425,505]
    if scenario != 'header-lost':
        for x,label in zip(xs,labels): write(x,159,label)
    lines = []
    for j,(qty,unit,amount) in enumerate([(quantity,price,first),(1,second,second)]):
        sku = f'KT-{group+100+j*100}'
        desc = (['Meter sleeve 24', 'Packing insert','Binding service'][batch] if not j else 'Finishing kit')
        row = [sku,desc,unit if reverse else qty,qty if reverse else unit,amount]
        for x,cell in zip(xs,row): write(x,184+j*45,cell)
        if scenario=='wrapped' and not j:
            write(xs[1],199,'Series 7');desc+=' Series 7'
        lines.append(dict(sku=sku,description=desc,quantity=qty,unitPrice=float(unit),amount=float(amount)))
    y=279
    def summary(label,value):
        nonlocal y
        # Independent field labels and numeric cells, as in a two-column PDF.
        write(310,y,label);write(491,y,value);y+=20
    summary('Subtotal',f'{subtotal:.2f}')
    if scenario=='partial-base': summary('Taxable amount',f'{first:.2f}')
    if scenario=='adjustments': summary('Shipping','6.00');summary('Discount','-2.00')
    if scenario=='split-tax':
        summary('GST 5%',money(first*Decimal('.05')));summary('PST 10%',money(second*Decimal('.10')))
    elif scenario not in ['no-tax','tax-rate','partial-base']:
        summary('Tax',f'{tax:.2f}')
    elif scenario!='no-tax': summary('Sales tax:',f'{rate}%')
    summary('Total',f'({total:.2f})' if credit else f'{total:.2f}')
    if scenario=='two-currencies':
        summary('Reference total (CAD)',money(total*Decimal('1.25')))
        write(35,435,f'1 {currency} = 1.25 CAD')
    canvas.save()
    data=buffer.getvalue()
    stem=f'case-{index+1:02}'
    # Independently read the rendered PDF words at cell locations, before image degradation.
    page=fitz.open(stream=data,filetype='pdf')[0]
    words=page.get_text('words')
    def cell(left,right,baseline):
        return ' '.join(w[4] for w in words if left-1<=w[0]<right-1 and abs(w[3]-baseline)<5)
    for j,line in enumerate(lines):
        y=184+j*45
        assert cell(35,116,y)==line['sku']
        description=cell(116,355,y)
        if scenario=='wrapped' and j==0: description+=' '+cell(116,355,199)
        assert description==line['description']
        values=[Decimal(cell(lo,hi,y)) for lo,hi in [(355,425),(425,505),(505,610)]]
        q,p=(values[1],values[0]) if reverse else values[:2]
        assert (q,p,values[2])==(line['quantity'],Decimal(str(line['unitPrice'])),Decimal(str(line['amount'])))
        assert money(q*p)==values[2]
    summary_values={}
    for y in range(279,430,20):
        label=cell(310,491,y)
        if label: summary_values[label]=cell(491,610,y)
    assert Decimal(summary_values['Subtotal'])==subtotal
    assert Decimal(summary_values['Total'].strip('()'))==total
    assert (sum(Decimal(str(l['amount'])) for l in lines)!=subtotal)==(scenario=='wrong-subtotal')
    if scenario=='split-tax': assert sum(Decimal(summary_values[k]) for k in ['GST 5%','PST 10%'])==tax
    elif 'Tax' in summary_values: assert Decimal(summary_values['Tax'])==tax
    elif scenario!='no-tax':
        basis=Decimal(summary_values.get('Taxable amount',summary_values['Subtotal']))
        assert money(basis*Decimal(summary_values['Sales tax:'].rstrip('%'))/100)==tax
    assert (subtotal+tax+sum(Decimal(summary_values.get(k,'0')) for k in ['Shipping','Discount'])!=total)==(scenario=='wrong-total')
    ext='pdf'
    if (batch==1 and index%3==0) or (batch==2 and index%2==0):
        pix=page.get_pixmap(matrix=fitz.Matrix(1.8,1.8))
        im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples)
        if batch==1:
            im=ImageEnhance.Contrast(im.convert('L')).enhance(.64).filter(ImageFilter.GaussianBlur(.75))
            ext='png'
        else:
            im=im.rotate(2.4,Image.Resampling.BICUBIC,fillcolor='white').transform(im.size,Image.Transform.AFFINE,(1,.035,-8,0,1,0),Image.Resampling.BICUBIC)
            ext='jpg'
        im.save(DOCS/f'{stem}.{ext}')
    else: (DOCS/f'{stem}.pdf').write_bytes(data)
    return dict(file=f'{stem}.{ext}',scenario=scenario,kind='credit_note' if credit else 'purchase_order' if order else 'invoice',
                number=None if scenario=='missing-number' else ref,supplier=supplier,currency=currency,subtotal=float(subtotal),
                printedTax=None if scenario in ['partial-base','tax-rate','no-tax'] else float(tax), total=-float(total) if credit else float(total),
                proposedTax=float(tax) if scenario in ['partial-base','tax-rate'] else None,lines=lines,
                discrepancy=scenario in ['wrong-subtotal','wrong-total'],ambiguous=scenario=='header-lost')
(ROOT/'answers.json').write_text(json.dumps([render(i) for i in range(48)],indent=2)+'\n')
