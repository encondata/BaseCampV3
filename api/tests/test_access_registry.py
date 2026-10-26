from serversherpa.access.resources import ACTIONS, REGISTRY, ROUTE_RESOURCE


def test_registry_shape():
    assert set(REGISTRY) == {"dashboard", "users", "workers", "clients", "partners",
                             "attachments", "settings", "access", "audit",
                             "devtools", "sites", "assets", "asset_models",
                             "containers", "initiatives", "scans", "status_rules",
                             "scanning_hardware", "labels", "time", "notifications",
                             "ai", "reports", "trucks", "warehouse", "kiosk", "wiki", "learning"}
    assert ACTIONS == ("view", "add", "change", "delete")
    assert REGISTRY["devtools"].developer_only is True
    assert REGISTRY["access"].always_viewable is True
    assert REGISTRY["access"].visible_to == frozenset({"global"})
    assert REGISTRY["workers"].visible_to == frozenset({"global", "partner", "self"})
    assert REGISTRY["clients"].visible_to == frozenset({"global", "client"})
    assert REGISTRY["sites"].visible_to == frozenset({"global"})
    assert REGISTRY["learning"].label == "Learning"
    assert REGISTRY["learning"].visible_to == frozenset({"global"})


def test_route_map():
    assert ROUTE_RESOURCE["/people/workers"] == "workers"
    assert ROUTE_RESOURCE["/access"] == "access"
    assert ROUTE_RESOURCE["/"] == "dashboard"
    assert ROUTE_RESOURCE["/sites"] == "sites"
    assert ROUTE_RESOURCE["/learning"] == "learning"
    assert ROUTE_RESOURCE["/admin/scans"] == "scans"


def test_learning_admin_default_grants():
    from serversherpa.access.defaults import DEFAULT_GRANTS

    assert DEFAULT_GRANTS["learning_admin"] == {
        "learning": ("view", "add", "change", "delete"), "wiki": ("view",)}
