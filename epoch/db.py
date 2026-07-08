"""SQLite engine + session helpers.

Ported near-verbatim from the sibling ``fetch`` project. WAL mode is enabled on
every connection so reads and the (single-user) writes stay consistent and
power-loss recovery is reliable.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, event, inspect, text
from sqlmodel import Session, SQLModel, create_engine

from epoch.config import Settings, get_settings

# Import models for side effects so SQLModel.metadata is populated before
# create_all() runs.
from epoch import models  # noqa: F401

_engine: Engine | None = None


def _configure_connection(dbapi_connection, connection_record) -> None:
    """Apply per-connection SQLite pragmas (WAL + sane durability)."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def create_db_engine(settings: Settings) -> Engine:
    """Create an engine for the configured DB path.

    A ``check_same_thread=False`` engine lets request handlers reuse connections
    (each still opens a short-lived session).
    """
    db_path = settings.db_path
    if db_path.parent and not db_path.parent.exists():
        db_path.parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    event.listen(engine, "connect", _configure_connection)
    return engine


def _add_missing_columns(engine: Engine) -> None:
    """Additively migrate existing tables: ``ADD COLUMN`` for any model column
    the live table is missing.

    ``SQLModel.metadata.create_all`` only creates *new* tables — it never alters
    an existing one — so a column added to a model would be invisible on an
    already-populated ``epoch.db``. This walks each mapped table that already
    exists and adds only the columns absent from disk. It is deliberately
    limited to additive, nullable columns (existing rows get NULL); a NOT NULL
    column without a server default would require a real migration and is
    intentionally out of scope for this home-lab-simple, no-Alembic schema
    evolution.
    """
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    for table in SQLModel.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue  # brand-new table — create_all already made it in full
        live_columns = {col["name"] for col in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in live_columns:
                continue
            col_type = column.type.compile(dialect=engine.dialect)
            with engine.begin() as conn:
                conn.execute(
                    text(
                        f'ALTER TABLE "{table.name}" '
                        f'ADD COLUMN "{column.name}" {col_type}'
                    )
                )


def init_db(settings: Settings | None = None) -> Engine:
    """Initialize the global engine and create tables. Idempotent."""
    global _engine
    settings = settings or get_settings()
    _engine = create_db_engine(settings)
    SQLModel.metadata.create_all(_engine)
    _add_missing_columns(_engine)
    return _engine


def get_engine() -> Engine:
    """Return the initialized engine, or raise if ``init_db`` hasn't run."""
    if _engine is None:
        raise RuntimeError("Database engine not initialized; call init_db() first.")
    return _engine


def reset_engine() -> None:
    """Dispose and clear the global engine (used between tests)."""
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None


@contextmanager
def get_session() -> Iterator[Session]:
    """Short-lived session context manager (open → work → close)."""
    with Session(get_engine()) as session:
        yield session
