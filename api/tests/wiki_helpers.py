"""Shared login helper for the wiki HTTP test suites — modeled on
`test_attachments.py::_login`/`_login_as`, but general enough to mint a
fresh person with any role set (and, for client_* roles, a client
anchor) rather than only retargeting the one seeded staff user."""
import uuid

from serversherpa.config import get_settings
from serversherpa.db.models import Person, PersonRole, UserAccount
from serversherpa.security.passwords import hash_password

PASSWORD = "CorrectHorse9!"


async def login_as(client, db, *, roles=("staff",), email=None,
                   client_id=None) -> tuple[dict, uuid.UUID]:
    """Create a fresh person + user account holding `roles` (each
    anchored to `client_id` when given, for client_* roles), log in, and
    return (headers, person_id)."""
    tag = uuid.uuid4().hex[:10]
    email = email or f"wiki-{tag}@test.example.com"

    person = Person(first_name="Wiki", last_name=f"Tester {tag}", email=email)
    db.add(person)
    await db.flush()
    db.add(UserAccount(
        person_id=person.id, email=email,
        password_hash=hash_password(
            PASSWORD, pepper=get_settings().password_pepper.get_secret_value())))
    for role in roles:
        db.add(PersonRole(person_id=person.id, role=role, client_id=client_id))
    await db.commit()

    resp = await client.post(
        "/auth/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['access_token']}"}, person.id
