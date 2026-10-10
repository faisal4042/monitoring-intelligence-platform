"""SSRF guard: schemes, private and special ranges in every encoding, DNS
answers pointing inside, and pinning to the vetted address."""
import pytest

from app.netguard import BlockedURL, Guard, is_public_ip


def guard_for(answers: dict[str, list[str]]) -> Guard:
    return Guard(resolver=lambda h, p: answers.get(h, []))


@pytest.mark.parametrize("url,code", [
    ("file:///etc/passwd", "scheme"),
    ("ftp://example.com/x", "scheme"),
    ("gopher://example.com/", "scheme"),
    ("http://user:pw@example.com/", "credentials"),
    ("http://localhost/", "internal_host"),
    ("http://foo.localhost/", "internal_host"),
    ("http://metadata.google.internal/", "internal_host"),
    ("http://127.0.0.1/", "private_address"),
    ("http://10.0.0.5/", "private_address"),
    ("http://172.16.3.4/", "private_address"),
    ("http://192.168.1.1/", "private_address"),
    ("http://169.254.169.254/latest/meta-data/", "private_address"),
    ("http://100.64.0.1/", "private_address"),
    ("http://0.0.0.0/", "private_address"),
    ("http://[::1]/", "private_address"),
    ("http://[fd00::1]/", "private_address"),
    ("http://[fe80::1]/", "private_address"),
    ("http://[::ffff:127.0.0.1]/", "private_address"),
    ("http://[::ffff:a9fe:a9fe]/", "private_address"),   # mapped 169.254.169.254
    ("http://[2002:7f00:1::]/", "private_address"),      # 6to4 of 127.0.0.1
    ("http://[64:ff9b::a00:1]/", "private_address"),     # NAT64 of 10.0.0.1
    ("http://2130706433/", "ip_encoding"),               # decimal 127.0.0.1
    ("http://0x7f000001/", "ip_encoding"),
    ("http://017700000001/", "ip_encoding"),
    ("http://example.com:22/", "port"),
    ("http://example.com:6379/", "port"),
])
def test_blocked(url, code):
    with pytest.raises(BlockedURL) as e:
        guard_for({"example.com": ["93.184.216.34"]}).check_url(url)
    assert e.value.code == code


def test_hostname_resolving_inside_is_blocked_even_if_one_answer_is_public():
    g = guard_for({"rebind.example": ["93.184.216.34", "10.1.2.3"]})
    with pytest.raises(BlockedURL) as e:
        g.check_url("https://rebind.example/a")
    assert e.value.code == "private_address"


def test_unresolvable_host_is_blocked():
    with pytest.raises(BlockedURL) as e:
        guard_for({}).check_url("https://nowhere.example/")
    assert e.value.code == "dns"


def test_public_target_is_pinned_to_vetted_addresses():
    t = guard_for({"news.example": ["2606:2800:220:1::1", "93.184.216.34", "93.184.216.35"]}).check_url("https://news.example/a?b=1")
    assert t.port == 443 and set(t.addresses) == {"93.184.216.34", "93.184.216.35", "2606:2800:220:1::1"}
    # One entry with every vetted address (curl keeps only the last entry per host:port), IPv4 first.
    assert t.curl_resolve() == ["news.example:443:93.184.216.34,93.184.216.35,[2606:2800:220:1::1]"]


def test_public_ip_classification():
    assert is_public_ip("8.8.8.8") and is_public_ip("2001:4860:4860::8888")
    for ip in ("127.0.0.1", "10.0.0.1", "169.254.1.1", "224.0.0.1", "::1", "fc00::1", "255.255.255.255"):
        assert not is_public_ip(ip), ip
