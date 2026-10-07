import base64
import uuid

import pytest
import yaml

from sirdar_api.deploy import cloudinit

ENV_ID = uuid.UUID("0b6c2f7e-1111-4222-8333-944455556666")
PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"
PUBLIC = "ssh-ed25519 AAAAhost root@ss-uat3"
CLIENT = "ssh-ed25519 AAAAclient sirdar@ss-uat3"


def test_static_metadata():
    meta = yaml.safe_load(cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3",
                                             ip_cidr="10.10.48.71/24", gateway="10.10.48.1",
                                             dns_servers=()))
    assert meta["instance-id"] == f"sirdar-{ENV_ID}" and meta["local-hostname"] == "ss-uat3"
    nic = meta["network"]["ethernets"]["nic0"]
    assert meta["network"]["version"] == 2
    assert nic == {"match": {"driver": "vmxnet3"}, "dhcp4": False,
                   "addresses": ["10.10.48.71/24"],
                   "routes": [{"to": "default", "via": "10.10.48.1"}],
                   "nameservers": {"addresses": ["10.10.48.1"]}}
    assert meta["cleanup-guestinfo"] == ["userdata"]


def test_dhcp_metadata_and_dns_servers():
    meta = yaml.safe_load(cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3", ip_cidr=None,
                                             gateway=None, dns_servers=("1.1.1.1", "9.9.9.9")))
    assert meta["network"]["ethernets"]["nic0"] == {
        "match": {"driver": "vmxnet3"}, "dhcp4": True,
        "nameservers": {"addresses": ["1.1.1.1", "9.9.9.9"]}}
    meta = yaml.safe_load(cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3", ip_cidr=None,
                                             gateway=None, dns_servers=()))
    assert "nameservers" not in meta["network"]["ethernets"]["nic0"]


def test_userdata():
    text = cloudinit.userdata(hostname="ss-uat3", ssh_public_key=CLIENT,
                              host_key_private=PRIVATE, host_key_public=PUBLIC)
    assert text.startswith("#cloud-config\n")
    doc = yaml.safe_load(text)
    [user] = doc["users"]
    assert (user["name"], user["sudo"], user["lock_passwd"], user["ssh_authorized_keys"]) == (
        "deploy", "ALL=(ALL) NOPASSWD:ALL", True, [CLIENT])
    assert doc["ssh_pwauth"] is False and doc["ssh_deletekeys"] is True
    assert doc["ssh_genkeytypes"] == []
    assert doc["ssh_keys"] == {"ed25519_private": PRIVATE, "ed25519_public": PUBLIC}
    assert doc["growpart"] == {"mode": "auto", "devices": ["/"]}


def test_guestinfo_is_base64_and_only_the_user_data_holds_the_private_key():
    meta = cloudinit.metadata(env_id=ENV_ID, hostname="ss-uat3", ip_cidr=None, gateway=None,
                              dns_servers=())
    user = cloudinit.userdata(hostname="ss-uat3", ssh_public_key=CLIENT,
                              host_key_private=PRIVATE, host_key_public=PUBLIC)
    info = cloudinit.guestinfo(meta, user)
    assert set(info) == {"guestinfo.metadata", "guestinfo.metadata.encoding",
                         "guestinfo.userdata", "guestinfo.userdata.encoding"}
    assert info["guestinfo.metadata.encoding"] == info["guestinfo.userdata.encoding"] == "base64"
    assert base64.b64decode(info["guestinfo.userdata"]).decode() == user
    assert "PRIVATE KEY" not in base64.b64decode(info["guestinfo.metadata"]).decode()
    assert cloudinit.scrub() == {"guestinfo.userdata": "", "guestinfo.userdata.encoding": ""}


@pytest.mark.parametrize("kw", [
    {"hostname": "ss-uat3\nfoo: bar"}, {"hostname": "ss-Uat3"}, {"hostname": ""},
    {"dns_servers": ("1.1.1.1\nfoo: bar",)}, {"dns_servers": ("nameserver",)},
    {"dns_servers": ("1.1.1.1", "1.0.0.1", "8.8.8.8", "9.9.9.9")},
    {"ip_cidr": "10.10.48.71/24\nfoo: bar"}, {"ip_cidr": "10.10.48.71"},
    {"gateway": "10.10.48.1\nfoo: bar"}, {"gateway": None},
    {"hostname": None}, {"dns_servers": None}, {"dns_servers": (None,)}, {"dns_servers": 3},
    {"ip_cidr": 3}, {"gateway": 3}, {"dns_servers": "1.1.1.1"},
])
def test_metadata_refuses_unchecked_inputs(kw):
    args = {"env_id": ENV_ID, "hostname": "ss-uat3", "ip_cidr": "10.10.48.71/24",
            "gateway": "10.10.48.1", "dns_servers": (), **kw}
    with pytest.raises(ValueError):
        cloudinit.metadata(**args)


def test_the_host_name_rule_is_the_vm_name_rule():
    from sirdar_api.deploy import vms
    assert cloudinit._HOSTNAME_RE.pattern == vms._VM_NAME_RE.pattern


def test_a_bluegreen_vm_s_host_name_and_instance_id():
    long = "a" + "b" * 31                                  # the longest environment name
    meta = yaml.safe_load(cloudinit.metadata(env_id=ENV_ID, hostname=f"ss-{long}-purple",
                                             ip_cidr=None, gateway=None, dns_servers=(),
                                             role="purple"))
    assert meta["instance-id"] == f"sirdar-{ENV_ID}-purple"
    assert meta["local-hostname"] == f"ss-{long}-purple"
    for too_long in (f"ss-{long}x-purple", "ss-" + "a" * 60):
        with pytest.raises(ValueError):
            cloudinit.metadata(env_id=ENV_ID, hostname=too_long, ip_cidr=None,
                               gateway=None, dns_servers=())


def test_droplet_userdata():
    text = cloudinit.droplet_userdata(hostname="ss-uat9-purple",
                                      ssh_public_key="ssh-ed25519 AAAAuser sirdar",
                                      host_key_private="-----BEGIN OPENSSH PRIVATE KEY-----\nx\n",
                                      host_key_public="ssh-ed25519 AAAAhost root")
    doc = yaml.safe_load(text.removeprefix("#cloud-config\n"))
    assert text.startswith("#cloud-config\n")
    assert doc["users"][0]["name"] == "deploy"
    assert doc["ssh_keys"]["ed25519_public"] == "ssh-ed25519 AAAAhost root"
    assert doc["ssh_genkeytypes"] == [] and doc["ssh_deletekeys"] is True
    assert "postgresql-client" in doc["packages"] and doc["package_update"] is True
    with pytest.raises(ValueError):
        cloudinit.droplet_userdata(hostname="bad name", ssh_public_key="k",
                                   host_key_private="p", host_key_public="h")


def test_droplet_userdata_keeps_the_esxi_rules():
    text = cloudinit.droplet_userdata(hostname="ss-uat9-orange", ssh_public_key=CLIENT,
                                      host_key_private=PRIVATE, host_key_public=PUBLIC)
    doc = yaml.safe_load(text.removeprefix("#cloud-config\n"))
    esxi = yaml.safe_load(cloudinit.userdata(hostname="ss-uat9-orange", ssh_public_key=CLIENT,
                                             host_key_private=PRIVATE, host_key_public=PUBLIC)
                          .removeprefix("#cloud-config\n"))
    assert {k: v for k, v in doc.items() if k not in ("packages", "package_update")} == esxi
    assert doc["ssh_keys"]["ed25519_private"] == PRIVATE
    assert len(text.encode()) < 64 * 1024


@pytest.mark.parametrize("hostname", ["ss-uat9-Orange", "ss-uat9\nfoo: bar", "uat9-orange",
                                      "ss-" + "a" * 60, None, "ss-uat9-"])
def test_droplet_userdata_refuses_bad_hostnames(hostname):
    with pytest.raises(ValueError):
        cloudinit.droplet_userdata(hostname=hostname, ssh_public_key=CLIENT,
                                   host_key_private=PRIVATE, host_key_public=PUBLIC)
