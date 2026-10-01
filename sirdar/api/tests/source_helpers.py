"""Write rows into the portal-shaped source test database (psycopg)."""

import json
import uuid

from sirdar_api.config import get_settings
from sirdar_api.security.passwords import hash_password


def add_role(conn, name: str, rank: int, *, scope: str = "global",
             totp_required: bool = False, label: str | None = None,
             color: str | None = None) -> None:
    conn.execute("INSERT INTO roles (name, label, rank, scope_anchor, totp_required, color) "
                 "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (name) DO NOTHING",
                 (name, label or name.replace("_", " ").title(), rank, scope, totp_required,
                  color))


def add_portal_person(conn, *, email: str, first: str = "Pat", last: str = "Portal",
                      roles: tuple[str, ...] = ("admin",), password: str = "CorrectHorse9!",
                      archived: bool = False, person: dict | None = None,
                      **account) -> uuid.UUID:
    pepper = get_settings().password_pepper.get_secret_value()
    pid = uuid.uuid4()
    conn.execute("INSERT INTO people (id, first_name, last_name, archived_at) "
                 "VALUES (%s, %s, %s, CASE WHEN %s THEN now() END)",
                 (pid, first, last, archived))
    for col, value in (person or {}).items():     # contact fields on the people row
        conn.execute(f"UPDATE people SET {col} = %s WHERE id = %s", (value, pid))
    cols = {"person_id": pid, "email": email,
            "password_hash": hash_password(password, pepper=pepper) if password else None,
            **account}
    names = ", ".join(cols)
    marks = ", ".join(["%s"] * len(cols))
    conn.execute(f"INSERT INTO user_accounts ({names}) VALUES ({marks})", tuple(cols.values()))
    for role in roles:
        conn.execute("INSERT INTO person_roles (person_id, role) VALUES (%s, %s)", (pid, role))
    return pid


def set_security(conn, data: dict) -> None:
    conn.execute("INSERT INTO system_config (section, data) VALUES ('security', %s) "
                 "ON CONFLICT (section) DO UPDATE SET data = EXCLUDED.data",
                 (json.dumps(data),))
