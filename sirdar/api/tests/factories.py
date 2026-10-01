import uuid

from sirdar_api.config import get_settings
from sirdar_api.db.models import User, UserRole
from sirdar_api.security.passwords import hash_password

PASSWORD = "CorrectHorse9!"


async def make_user(db, *, email: str = "alice@test.example.com",
                    roles: tuple[str, ...] = ("admin",), source: str = "portal",
                    first_name: str = "Alice", last_name: str = "Anderson",
                    **fields) -> User:
    pepper = get_settings().password_pepper.get_secret_value()
    fields.setdefault("password_hash", hash_password(PASSWORD, pepper=pepper))
    user = User(person_id=fields.pop("person_id", uuid.uuid4()), source=source, email=email,
                first_name=first_name, last_name=last_name, **fields)
    db.add(user)
    await db.flush()
    for role in roles:
        db.add(UserRole(person_id=user.person_id, role=role))
    await db.commit()
    return user
