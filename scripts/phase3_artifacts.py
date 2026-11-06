import json
from pathlib import Path
from tempfile import NamedTemporaryFile

from psycopg.conninfo import make_conninfo

SOURCE = Path(".artifacts/benchmark-fixture")
TARGET = Path(".artifacts/online-fixture")


def write(target: Path, value):
    target.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
        path = Path(temporary.name)
        temporary.write(json.dumps(value, ensure_ascii=False).encode())
        path.chmod(0o444)
    path.replace(target)


def main():
    TARGET.mkdir(mode=0o700, parents=True, exist_ok=True)
    TARGET.chmod(0o700)
    for split in ("dev", "validation"):
        for role, names in (
            ("dispatcher", ("manifest", "prompts")),
            ("evaluator", ("manifest", "oracles")),
        ):
            for name in names:
                source = SOURCE / split / f"{name}.json"
                write(TARGET / role / split / source.name, json.loads(source.read_text()))
        runtime = json.loads((SOURCE / ".runtime" / f"{split}.json").read_text())
        write(
            TARGET / "runner" / f"{split}.json",
            {
                name: make_conninfo(dsn, host="sandbox-db", port=5432)
                for name, dsn in runtime.items()
            },
        )


if __name__ == "__main__":
    main()
