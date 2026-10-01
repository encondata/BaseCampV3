async def test_root_serves_index(client):
    r = await client.get("/")
    assert r.status_code == 200
    assert '<div id="root">' in r.text


async def test_asset_file_served(client):
    r = await client.get("/assets/app.js")
    assert r.status_code == 200
    assert "kiosk" in r.text


async def test_spa_route_falls_back_to_index(client):
    r = await client.get("/labels/printers")
    assert r.status_code == 200
    assert '<div id="root">' in r.text


async def test_path_traversal_gets_index_not_file(client, settings):
    (settings.data_dir / "secret.txt").write_text("nope")
    r = await client.get("/../data/secret.txt")
    assert "nope" not in r.text


async def test_config_js_carries_laptop_mode_and_identity(client, app):
    r = await client.get("/config.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    assert '"mode": "laptop"' in r.text
    assert app.state.identity.serial in r.text
    assert "apiUrl: window.location.origin" in r.text


async def test_edge_identity_endpoint(client, app):
    r = await client.get("/edge/identity")
    assert r.json() == {"serial": app.state.identity.serial, "name": app.state.identity.name}


async def test_unknown_non_get_is_404(client):
    r = await client.post("/not-an-api")
    assert r.status_code == 404
