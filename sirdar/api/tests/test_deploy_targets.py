from sirdar_api.deploy import targets

from .test_scaffold import _settings


def _by_id(settings):
    return {t["id"]: t for t in targets.public_targets(settings)}


def test_registry_ids_labels_and_availability():
    assert [(t.id, t.label, t.available) for t in targets.TARGETS] == [
        ("aws", "AWS", False), ("gcp", "Google Cloud", False),
        ("digitalocean", "DigitalOcean", True), ("ssh", "Custom (SSH)", True)]


def test_deploy_types():
    assert targets.DEPLOY_TYPES == [
        {"id": "blue", "label": "Blue", "description": "Production slot"},
        {"id": "green", "label": "Green", "description": "Production slot"},
        {"id": "dev", "label": "Dev", "description": "Development"},
        {"id": "beta", "label": "Beta", "description": "External testing"},
        {"id": "custom", "label": "Custom", "description": "Your own named environment"}]


def test_nothing_configured_by_default(tmp_path):
    out = _by_id(_settings(deploy_targets_file=str(tmp_path / "none.env")))
    assert {k: v["configured"] for k, v in out.items()} == {
        "aws": False, "gcp": False, "digitalocean": False}     # no installer SSH target


def test_installer_target_listed_when_any_ssh_value_set(tmp_path):
    f = str(tmp_path / "none.env")
    for over in ({"deploy_ssh_host": "h"}, {"deploy_ssh_user": "u"},
                 {"deploy_ssh_password": "pw"}, {"deploy_ssh_key_path": "k"},
                 {"deploy_ssh_key_passphrase": "pp"}, {"deploy_ssh_port": 2222}):
        ssh = _by_id(_settings(deploy_targets_file=f, **over))["ssh"]
        assert ssh == {"id": "ssh", "label": "Custom (SSH) · Installer", "kind": "ssh",
                       "source": "installer", "available": True, "configured": False}


def test_digitalocean_configured():
    t = _by_id(_settings(deploy_do_token="dop_v1_SECRET", deploy_do_region="nyc3"))
    assert t["digitalocean"] == {"id": "digitalocean", "label": "DigitalOcean",
                                 "kind": "digitalocean", "available": True, "configured": True}
    assert not _by_id(_settings(deploy_do_region="nyc3"))["digitalocean"]["configured"]


def test_ssh_configured_rules():
    base = dict(deploy_ssh_host="10.10.48.20", deploy_ssh_user="root")
    assert not _by_id(_settings(**base))["ssh"]["configured"]
    assert not _by_id(_settings(deploy_ssh_host="h", deploy_ssh_password="pw"))["ssh"]["configured"]
    assert not _by_id(_settings(deploy_ssh_user="u", deploy_ssh_password="pw"))["ssh"]["configured"]
    assert _by_id(_settings(**base, deploy_ssh_key_path="id_ed25519"))["ssh"]["configured"]
    assert _by_id(_settings(**base, deploy_ssh_password="hunter2-SECRET",
                            deploy_ssh_port=2222))["ssh"]["configured"]


def test_aws_and_gcp_configured_rules():
    aws = _by_id(_settings(deploy_aws_access_key_id="AKIA", deploy_aws_secret_access_key="SECRET",
                           deploy_aws_region="us-east-1"))["aws"]
    assert aws == {"id": "aws", "label": "AWS", "kind": "aws", "available": False,
                   "configured": True}
    assert not _by_id(_settings(deploy_aws_access_key_id="AKIA"))["aws"]["configured"]
    gcp = _by_id(_settings(deploy_gcp_project_id="proj-1",
                           deploy_gcp_credentials_file="/app/gcp.json"))["gcp"]
    assert gcp["configured"]
    assert not _by_id(_settings(deploy_gcp_project_id="p"))["gcp"]["configured"]


def test_summaries_never_contain_secrets():
    s = _settings(deploy_do_token="TOKSECRET", deploy_aws_access_key_id="AKIA",
                  deploy_aws_secret_access_key="AWSSECRET", deploy_ssh_host="h",
                  deploy_ssh_user="u", deploy_ssh_password="PWSECRET",
                  deploy_ssh_key_passphrase="PASSSECRET", deploy_ssh_key_path="k")
    blob = repr(targets.public_targets(s))
    for secret in ("TOKSECRET", "AWSSECRET", "PWSECRET", "PASSSECRET"):
        assert secret not in blob


def test_vm_targets():
    assert targets.VM_TARGETS == ("proxmox", "esxi")
    assert targets.is_vm_target("esxi") and targets.is_vm_target("proxmox")
    assert not targets.is_vm_target("ssh") and not targets.is_vm_target("ssh:uat")
