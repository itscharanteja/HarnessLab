from datetime import datetime
from secrets import token_urlsafe

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row

from .data import TABLES, Rows, Variant, digest, sort_rows

type Connection = psycopg.Connection


def relation(mapping: dict, table: str, schema: str) -> sql.Identifier:
    return sql.Identifier(schema, mapping[table]["relation"])


def column(mapping: dict, table: str, name: str) -> sql.Identifier:
    return sql.Identifier(mapping[table]["columns"][name])


def load_schema(conn: Connection, variant: Variant, schema: str, rows: Rows) -> None:
    mapping = variant.mapping
    conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    for logical, physical in mapping.items():
        spec = TABLES[logical]
        fields = [
            sql.SQL("{} {}{}").format(
                column(mapping, logical, key),
                sql.SQL(spec.columns[key]),
                sql.SQL("") if key == "ended_at" else sql.SQL(" NOT NULL"),
            )
            for key in physical["columns"]
        ]
        fields.append(
            sql.SQL("PRIMARY KEY ({})").format(
                sql.SQL(", ").join(column(mapping, logical, key) for key in spec.pk),
            )
        )
        conn.execute(
            sql.SQL("CREATE TABLE {} ({})").format(
                relation(mapping, logical, schema),
                sql.SQL(", ").join(fields),
            )
        )
    for logical, spec in TABLES.items():
        target = relation(mapping, logical, schema)
        keys = tuple(spec.columns)
        statement = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
            target,
            sql.SQL(", ").join(column(mapping, logical, key) for key in keys),
            sql.SQL(", ").join(sql.Placeholder() for _ in keys),
        )
        with conn.cursor() as cursor:
            cursor.executemany(
                statement, [tuple(row[key] for key in keys) for row in rows[logical]]
            )
        for key, parent in spec.fks:
            conn.execute(
                sql.SQL("ALTER TABLE {} ADD FOREIGN KEY ({}) REFERENCES {} ({})").format(
                    target,
                    column(mapping, logical, key),
                    relation(mapping, parent, schema),
                    column(mapping, parent, "id"),
                )
            )
        index_columns = {key for key, _ in spec.fks} | {
            key for key, datatype in spec.columns.items() if datatype == "timestamptz"
        }
        for key in sorted(index_columns):
            conn.execute(
                sql.SQL("CREATE INDEX ON {} ({})").format(
                    target,
                    column(mapping, logical, key),
                )
            )


def read_rows(conn: Connection, variant: Variant, schema: str) -> Rows:
    mapping = variant.mapping
    rows: Rows = {}
    with conn.cursor(row_factory=dict_row) as cursor:
        for table, spec in TABLES.items():
            selectors = sql.SQL(", ").join(
                sql.SQL("{} AS {}").format(column(mapping, table, name), sql.Identifier(name))
                for name in spec.columns
            )
            cursor.execute(
                sql.SQL("SELECT {} FROM {}").format(
                    selectors,
                    relation(mapping, table, schema),
                )
            )
            rows[table] = [
                {
                    key: value.strftime("%Y-%m-%dT%H:%M:%SZ")
                    if isinstance(value, datetime)
                    else value
                    for key, value in row.items()
                }
                for row in cursor.fetchall()
            ]
    return sort_rows(rows)


def install_variant(conn: Connection, variant: Variant, rows: Rows) -> None:
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (variant.schema,))
    if conn.execute("SELECT to_regnamespace(%s)", (variant.schema,)).fetchone()[0] is None:
        load_schema(conn, variant, variant.schema, rows)
    if digest(read_rows(conn, variant, variant.schema)) != digest(rows):
        raise ValueError(f"Stored variant {variant.key} differs from the generated rows")


def runtime_dsn(conn: Connection, variant: Variant, seed_dsn: str, existing: str | None) -> str:
    db = conn.info.dbname
    role = sql.Identifier(variant.role)
    schema = sql.Identifier(variant.schema)
    role_exists = conn.execute(
        "SELECT 1 FROM pg_roles WHERE rolname = %s", (variant.role,)
    ).fetchone()
    params = conninfo_to_dict(seed_dsn)
    if existing and role_exists:
        if conninfo_to_dict(existing).get("user") != variant.role:
            raise ValueError(f"Invalid fixture credential for {variant.key}")
        return existing
    password = token_urlsafe(32)
    if role_exists:
        conn.execute(sql.SQL("ALTER ROLE {} PASSWORD {}").format(role, sql.Literal(password)))
    else:
        conn.execute(
            sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(role, sql.Literal(password))
        )
    conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(db), role))
    conn.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(schema, role))
    conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(schema, role))
    conn.execute(
        sql.SQL("ALTER ROLE {} IN DATABASE {} SET search_path = pg_catalog, {}").format(
            role,
            sql.Identifier(db),
            schema,
        )
    )
    conn.execute(
        sql.SQL("ALTER ROLE {} IN DATABASE {} SET default_transaction_read_only = on").format(
            role,
            sql.Identifier(db),
        )
    )
    return make_conninfo(**{**params, "user": variant.role, "password": password})
