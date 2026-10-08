"""Effective notification settings: a member's overrides merged onto the
group defaults. The single implementation of inheritance, used by the
member detail payload, the my-groups payload and the email sender."""

from serversherpa.db.models import NotificationGroup, NotificationGroupMember


def effective_settings(group: NotificationGroup,
                        member: NotificationGroupMember) -> dict:
    """Merge a member's overrides onto the group defaults."""
    if member.quiet_mode is None:
        quiet_start, quiet_end = group.quiet_start, group.quiet_end
    elif member.quiet_mode == "none":
        quiet_start, quiet_end = None, None
    else:  # "custom"
        quiet_start, quiet_end = member.quiet_start, member.quiet_end
    return {
        "channels": member.channels if member.channels is not None
                    else group.channels,
        "quiet_start": quiet_start,
        "quiet_end": quiet_end,
        "timezone": member.timezone if member.timezone is not None
                    else group.timezone,
        "active_days": member.active_days if member.active_days is not None
                        else group.active_days,
        "dnd_behavior": member.dnd_behavior if member.dnd_behavior is not None
                        else group.dnd_behavior,
        "urgent_bypass": member.urgent_bypass if member.urgent_bypass is not None
                          else group.urgent_bypass,
    }
