"""PostgreSQL ledger for the isolated Cloud Run holdout job."""

import psycopg
from psycopg.conninfo import conninfo_to_dict


class PostgresLedger:
    def __init__(self, dsn: str, database: str, digest: str, *, require_tls: bool = True):
        parsed = conninfo_to_dict(dsn)
        if (
            parsed.get("dbname") != database
            or parsed.get("user") != "hl_holdout_ledger"
            or database in {"harnesslab_control", "harnesslab_sandbox", "harnesslab_holdout"}
            or require_tls
            and parsed.get("sslmode") != "verify-full"
            or not require_tls
            and parsed.get("host") not in {"127.0.0.1", "localhost"}
        ):
            raise ValueError("dedicated_holdout_ledger_required")
        self.connection = psycopg.connect(
            dsn,
            autocommit=True,
            connect_timeout=5,
            options="-c search_path=hl_holdout_ledger,pg_catalog -c statement_timeout=5000",
        )
        try:
            (locked,) = self.connection.execute(
                "SELECT pg_try_advisory_lock(hashtextextended(%s,74163290))", (digest,)
            ).fetchone()
            if not locked:
                raise ValueError("holdout_already_running")
        except BaseException:
            self.connection.close()
            raise

    def __enter__(self):
        self.transaction = self.connection.transaction()
        self.transaction.__enter__()
        return self

    def __exit__(self, *error):
        return self.transaction.__exit__(*error)

    def execute(self, query, params=()):
        if query.startswith("INSERT OR IGNORE INTO evaluations"):
            query = query.replace("INSERT OR IGNORE", "INSERT", 1) + " ON CONFLICT DO NOTHING"
        return self.connection.execute(query.replace("?", "%s"), params)

    def close(self):
        self.connection.close()
