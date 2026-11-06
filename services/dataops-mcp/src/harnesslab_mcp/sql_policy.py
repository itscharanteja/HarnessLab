import re
from dataclasses import dataclass

from pglast import ast, parse_sql
from pglast.parser import ParseError
from pglast.stream import RawStream

MAX_SQL_BYTES = 8192
FUNCTIONS = {"count", "sum", "avg", "min", "max", "round", "date_trunc"}
OPERATORS = {"+", "-", "*", "/", "%", "=", "<>", "!=", "<", "<=", ">", ">="}
TYPES = {"bool", "int2", "int4", "int8", "numeric", "text", "date", "timestamp", "timestamptz"}
VARIANT_SUFFIX = re.compile(r"_([dvh][0-9]{2}|[vh][0-9a-f]{12})$")
SYSTEM_COLUMNS = {"tableoid", "ctid", "xmin", "xmax", "cmin", "cmax", "oid"}

# The parser produces raw PostgreSQL 16 nodes. Only the listed children are visited.
# Any other populated field or node is rejected, including extensions to the grammar.
CHILDREN = {
    ast.SelectStmt: (
        "targetList",
        "fromClause",
        "whereClause",
        "groupClause",
        "havingClause",
        "sortClause",
        "limitOffset",
        "limitCount",
        "distinctClause",
    ),
    ast.RangeVar: ("alias",),
    ast.Alias: ("colnames",),
    ast.RangeSubselect: ("subquery", "alias"),
    ast.JoinExpr: ("larg", "rarg", "quals", "usingClause", "alias"),
    ast.SubLink: ("subselect",),
    ast.ResTarget: ("val",),
    ast.ColumnRef: ("fields",),
    ast.FuncCall: ("args", "agg_filter"),
    ast.A_Expr: ("lexpr", "rexpr"),
    ast.A_Const: ("val",),
    ast.BoolExpr: ("args",),
    ast.NullTest: ("arg",),
    ast.BooleanTest: ("arg",),
    ast.CoalesceExpr: ("args",),
    ast.CaseExpr: ("arg", "args", "defresult"),
    ast.CaseWhen: ("expr", "result"),
    ast.TypeCast: ("arg", "typeName"),
    ast.TypeName: ("typmods",),
    ast.SortBy: ("node",),
    ast.String: (),
    ast.Integer: (),
    ast.Float: (),
    ast.Boolean: (),
    ast.A_Star: (),
}
ATTRIBUTES = {
    ast.SelectStmt: {"withClause", "op", "limitOption"},
    ast.RangeVar: {"relname", "schemaname", "inh", "relpersistence"},
    ast.Alias: {"aliasname"},
    ast.JoinExpr: {"jointype"},
    ast.SubLink: {"subLinkType"},
    ast.ResTarget: {"name"},
    ast.FuncCall: {"funcname", "funcformat", "agg_star", "agg_distinct"},
    ast.A_Expr: {"kind", "name"},
    ast.A_Const: {"isnull"},
    ast.BoolExpr: {"boolop"},
    ast.NullTest: {"nulltesttype"},
    ast.BooleanTest: {"booltesttype"},
    ast.TypeName: {"names", "typemod"},
    ast.SortBy: {"sortby_dir", "sortby_nulls"},
    ast.String: {"sval"},
    ast.Integer: {"ival"},
    ast.Float: {"fval"},
    ast.Boolean: {"boolval"},
}


class QueryRejected(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Query:
    sql: str
    relations: tuple[str, ...]


def check_query(source: str, schema: str, tables: set[str]) -> Query:
    if "\x00" in source:
        raise QueryRejected("syntax_error")
    if len(source.encode()) > MAX_SQL_BYTES:
        raise QueryRejected("sql_too_large")
    try:
        statements = parse_sql(source)
    except ParseError:
        raise QueryRejected("syntax_error") from None
    if len(statements) != 1 or not isinstance(statements[0].stmt, ast.SelectStmt):
        raise QueryRejected("sql_policy")

    relations: set[str] = set()
    unresolved = False

    def visit(node, ctes: frozenset[str], depth: int = 0):
        nonlocal unresolved
        if node is None:
            return
        if depth > 80:
            raise QueryRejected("sql_policy")
        if isinstance(node, tuple):
            for child in node:
                visit(child, ctes, depth + 1)
            return

        kind = type(node)
        if kind not in CHILDREN:
            raise QueryRejected("sql_policy")
        allowed = set(CHILDREN[kind]) | ATTRIBUTES.get(kind, set()) | {"location"}
        if any(getattr(node, name) for name in node if name not in allowed):
            raise QueryRejected("sql_policy")

        if kind is ast.SelectStmt:
            if node.op.name != "SETOP_NONE" or node.limitOption.name == "LIMIT_OPTION_WITH_TIES":
                raise QueryRejected("sql_policy")
            if node.withClause:
                if node.withClause.recursive:
                    raise QueryRejected("sql_policy")
                for cte in node.withClause.ctes:
                    if (
                        cte.search_clause
                        or cte.cycle_clause
                        or not isinstance(cte.ctequery, ast.SelectStmt)
                        or cte.ctename in tables
                        or cte.ctename in ctes
                    ):
                        raise QueryRejected("sql_policy")
                    visit(cte.ctequery, ctes, depth + 1)
                    ctes = ctes | {cte.ctename}
        elif kind is ast.RangeVar:
            if node.schemaname not in {None, schema} or node.relname.startswith("pg_"):
                raise QueryRejected("sql_policy")
            if node.schemaname is None and node.relname in ctes:
                pass
            elif node.relname in tables:
                relations.add(node.relname)
                # Prevent traversal into inherited relations outside the active schema.
                node.inh = False
                node.schemaname = schema
            else:
                variant = VARIANT_SUFFIX.search(node.relname)
                if node.schemaname is not None or (variant and f"hl_{variant[1]}" != schema):
                    raise QueryRejected("sql_policy")
                unresolved = True
        elif kind is ast.FuncCall:
            if len(node.funcname) != 1 or node.funcname[0].sval not in FUNCTIONS:
                raise QueryRejected("sql_policy")
        elif kind is ast.A_Expr:
            names = tuple(part.sval for part in node.name or ())
            if node.kind.name not in {"AEXPR_OP", "AEXPR_IN", "AEXPR_BETWEEN", "AEXPR_NOT_BETWEEN"}:
                raise QueryRejected("sql_policy")
            if len(names) != 1 or (
                names[0] not in OPERATORS and names[0] not in {"BETWEEN", "NOT BETWEEN"}
            ):
                raise QueryRejected("sql_policy")
        elif kind is ast.TypeName:
            names = tuple(part.sval for part in node.names)
            if names[-1] not in TYPES or (len(names) != 1 and names[:-1] != ("pg_catalog",)):
                raise QueryRejected("sql_policy")
            if any(not isinstance(mod, ast.A_Const) for mod in node.typmods or ()):
                raise QueryRejected("sql_policy")
            node.names = (ast.String(sval="pg_catalog"), ast.String(sval=names[-1]))
        elif kind is ast.ColumnRef:
            if len(node.fields) > 2 or any(
                isinstance(part, ast.String) and part.sval.lower() in SYSTEM_COLUMNS
                for part in node.fields
            ):
                raise QueryRejected("sql_policy")
        elif kind is ast.SubLink and node.subLinkType.name not in {
            "EXPR_SUBLINK",
            "EXISTS_SUBLINK",
        }:
            raise QueryRejected("sql_policy")
        elif kind is ast.SortBy and node.sortby_dir.name == "SORTBY_USING":
            raise QueryRejected("sql_policy")

        for name in CHILDREN[kind]:
            visit(getattr(node, name), ctes, depth + 1)

    visit(statements[0].stmt, frozenset())
    if unresolved:
        raise QueryRejected("missing_relation")
    if not relations:
        raise QueryRejected("sql_policy")
    return Query(RawStream()(statements[0].stmt), tuple(sorted(relations)))
