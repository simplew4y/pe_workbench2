"""Bounded decimal expression interpreter. No eval, attributes, imports or I/O in expressions."""
import ast
import json
import sys
from decimal import Decimal, localcontext, ROUND_HALF_UP, ROUND_UP, ROUND_DOWN


def calculate(expression):
    if not isinstance(expression, str) or not 0 < len(expression) <= 2000:
        raise ValueError('expression must be 1–2000 characters')
    tree = ast.parse(expression.replace('^', '**'), mode='eval')
    if sum(1 for _ in ast.walk(tree)) > 300:
        raise ValueError('expression too complex')
    # get_source_segment must use the same normalized text as the AST offsets.
    source = expression.replace('^', '**')
    def visit(node, depth=0):
        if depth > 30:
            raise ValueError('expression too deep')
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            value = Decimal(ast.get_source_segment(source, node))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand, depth+1) * (-1 if isinstance(node.op, ast.USub) else 1)
        elif isinstance(node, ast.BinOp):
            a, b = visit(node.left, depth+1), visit(node.right, depth+1)
            if isinstance(node.op, ast.Add): value = a+b
            elif isinstance(node.op, ast.Sub): value = a-b
            elif isinstance(node.op, ast.Mult): value = a*b
            elif isinstance(node.op, ast.Div): value = a/b
            elif isinstance(node.op, ast.Pow):
                if abs(b) > 100 or b != b.to_integral_value():
                    raise ValueError('power requires integer exponent within ±100')
                value = a**int(b)
            else: raise ValueError('unsupported operator')
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            args = [visit(x, depth+1) for x in node.args]
            name = node.func.id.upper()
            if name in ('ROUND', 'ROUNDUP', 'ROUNDDOWN') and len(args) == 2:
                digits = args[1]
                if digits != digits.to_integral_value() or abs(digits) > 30:
                    raise ValueError('round digits must be integer within ±30')
                rounding = {'ROUND':ROUND_HALF_UP, 'ROUNDUP':ROUND_UP, 'ROUNDDOWN':ROUND_DOWN}[name]
                value = args[0].quantize(Decimal(1).scaleb(-int(digits)), rounding=rounding)
            elif name == 'ABS' and len(args) == 1: value = abs(args[0])
            elif name in ('MIN', 'MAX', 'SUM') and args:
                value = {'MIN': min, 'MAX': max, 'SUM': sum}[name](args)
            elif name == 'NPV' and len(args) >= 2:
                value = sum(cf / (1+args[0])**i for i, cf in enumerate(args[1:], 1))
            else: raise ValueError('unsupported function or arity')
        else: raise ValueError('unsupported expression syntax')
        if not value.is_finite() or abs(value.adjusted()) > 200:
            raise ValueError('result out of range')
        return value
    with localcontext() as ctx:
        ctx.prec = 50
        return visit(tree.body)


def run(data):
    value = calculate(data['expression'])
    expression_value = value
    units = {'元':Decimal(1),'千元':Decimal(1000),'万元':Decimal(10000),'百万元':Decimal(1000000),'亿元':Decimal(100000000),
             'million':Decimal(1000000),'billion':Decimal(1000000000)}
    src, dst = data.get('from_unit'), data.get('to_unit')
    if src or dst:
        if src not in units or dst not in units:
            raise ValueError('unsupported units; currency conversion requires explicit rate in expression')
        with localcontext() as ctx:
            ctx.prec = 50
            value = value * units[src] / units[dst]
    text = format(value, 'f')
    if '.' in text: text = text.rstrip('0').rstrip('.')
    return {'value':text if value else '0','expression_value':format(expression_value,'f'),'from_unit':src or None,'conversion_applied':bool(src or dst),'unit':dst or None,'precision':50,'rounding':'Excel ROUND half-away-from-zero; ROUNDUP away-from-zero; ROUNDDOWN toward-zero'}

try:
    print(json.dumps({'ok':True, **run(json.load(sys.stdin))}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'ok':False,'error':str(exc)}, ensure_ascii=False))
    sys.exit(1)
