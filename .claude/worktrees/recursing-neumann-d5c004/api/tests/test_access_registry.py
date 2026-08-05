from serversherpa.access.resources import ACTIONS, REGISTRY, ROUTE_RESOURCE


def test_registry_shape():
    assert set(REGISTRY) == {"dashboard", "users", "workers", "clients", "partners",
                             "attachments", "settings", "access", "audit",
                             "devtools", "sites"}
    assert ACTIONS == ("view", "add", "change", "delete")
    assert REGISTRY["devtools"].developer_only is True
    assert REGISTRY["access"].always_viewable is True
    assert REGISTRY["access"].visible_to == frozenset({"global"})
    assert REGISTRY["workers"].visible_to == frozenset({"global", "partner", "self"})
    assert REGISTRY["clients"].visible_to == frozenset({"global", "client"})
    assert REGISTRY["sites"].visible_to == frozenset({"global"})


def test_route_map():
    assert ROUTE_RESOURCE["/people/workers"] == "workers"
    assert ROUTE_RESOURCE["/access"] == "access"
    assert ROUTE_RESOURCE["/"] == "dashboard"
    assert ROUTE_RESOURCE["/sites"] == "sites"
