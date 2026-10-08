from serversherpa.access.resolver import AccessInfo
from serversherpa.access.visibility import (
    VISIBILITY_LEVELS,
    can_set_visibility,
    visible_levels,
)


def _acc(is_global: bool, rank: int) -> AccessInfo:
    return AccessInfo(is_global=is_global, max_rank=rank,
                      anchors={"global"} if is_global else {"client"})


def test_levels_constant():
    assert VISIBILITY_LEVELS == ("everyone", "internal", "admin")


def test_non_global_sees_everyone_only():
    assert visible_levels(_acc(False, 30)) == ("everyone",)


def test_staff_sees_everyone_and_internal():
    assert visible_levels(_acc(True, 40)) == ("everyone", "internal")


def test_admin_and_up_see_all():
    for rank in (60, 80, 100):
        assert visible_levels(_acc(True, rank)) == VISIBILITY_LEVELS


def test_can_set_matches_visible_levels():
    assert can_set_visibility(_acc(True, 40), "internal")
    assert not can_set_visibility(_acc(True, 40), "admin")
    assert can_set_visibility(_acc(True, 60), "admin")
    assert not can_set_visibility(_acc(True, 60), "secret")
