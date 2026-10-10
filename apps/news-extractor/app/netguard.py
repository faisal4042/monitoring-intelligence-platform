"""SSRF guard. Every URL the extractor touches passes through here first.

A string check on the URL is not enough: a public-looking hostname can
resolve to a private address, or change its answer between the check and the
connection (DNS rebinding). So we resolve the host ourselves, reject the whole
answer if any address is non-public, and hand back the vetted address so the
fetcher can pin the connection to it (curl RESOLVE). Redirects are followed by
the caller one hop at a time, and each hop comes back through ``check_url``.
"""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlsplit

Resolver = Callable[[str, int], list[str]]

# Hostnames that must never be fetched regardless of what they resolve to.
_BLOCKED_HOSTNAMES = {"localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data"}
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".lan", ".corp")


class BlockedURL(Exception):
    """The URL is not allowed to be fetched; ``code`` is stable for metrics."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Target:
    url: str
    scheme: str
    host: str
    port: int
    addresses: tuple[str, ...]

    def curl_resolve(self) -> list[str]:
        """One ``host:port:addr1,addr2`` entry pinning curl to the vetted addresses.

        A single entry with the full list, IPv4 first: curl keeps only the last
        of several entries for the same host:port, so separate entries would
        silently reduce the pin to one (possibly unreachable IPv6) address."""
        ordered = sorted(self.addresses, key=lambda a: ":" in a)
        return [f"{self.host}:{self.port}:" + ",".join(a if ":" not in a else f"[{a}]" for a in ordered)]


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({info[4][0] for info in infos})


def is_public_ip(raw: str) -> bool:
    ip = ipaddress.ip_address(raw.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address):
        # IPv4 embedded in IPv6 (mapped, 6to4, Teredo) is judged by its IPv4 part.
        if ip.ipv4_mapped is not None:
            return is_public_ip(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return is_public_ip(str(ip.sixtofour))
        if ip.teredo is not None:
            return is_public_ip(str(ip.teredo[1]))
        if ip in ipaddress.ip_network("64:ff9b::/96"):  # NAT64 well-known prefix
            return is_public_ip(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified or not ip.is_global
    )


class Guard:
    def __init__(self, resolver: Resolver = system_resolver, allow_hosts: frozenset[str] = frozenset(),
                 ports: frozenset[int] = frozenset({80, 443, 8080, 8443})):
        # ``allow_hosts`` exists only for tests that run a local fixture server;
        # it is never read from the environment.
        self._resolve = resolver
        self._allow = allow_hosts
        self._ports = ports

    def check_url(self, url: str) -> Target:
        if len(url) > 2048:
            raise BlockedURL("url_too_long", "URL exceeds 2048 characters")
        parts = urlsplit(url)
        scheme = (parts.scheme or "").lower()
        if scheme not in ("http", "https"):
            raise BlockedURL("scheme", f"scheme not allowed: {scheme or 'none'}")
        if parts.username or parts.password:
            raise BlockedURL("credentials", "URLs with embedded credentials are not allowed")
        host = (parts.hostname or "").rstrip(".").lower()
        if not host:
            raise BlockedURL("host", "URL has no host")
        try:
            port = parts.port or (443 if scheme == "https" else 80)
        except ValueError as e:
            raise BlockedURL("port", "invalid port") from e
        if port not in self._ports:
            raise BlockedURL("port", f"port not allowed: {port}")
        if host in self._allow:
            return Target(url, scheme, host, port, tuple(self._resolve(host, port)))
        if host in _BLOCKED_HOSTNAMES or host.endswith(_BLOCKED_SUFFIXES):
            raise BlockedURL("internal_host", "internal hostname")

        try:  # literal IP (including decimal/octal forms the OS would accept)
            literal = ipaddress.ip_address(host.strip("[]"))
            addresses = [str(literal)]
        except ValueError:
            if host.replace(".", "").isdigit() or host.startswith("0x"):
                raise BlockedURL("ip_encoding", "numeric host encodings are not allowed")
            try:
                addresses = self._resolve(host, port)
            except OSError as e:
                raise BlockedURL("dns", f"DNS resolution failed: {e}") from e
        if not addresses:
            raise BlockedURL("dns", "host resolved to no addresses")
        for addr in addresses:
            if not is_public_ip(addr):
                raise BlockedURL("private_address", "host resolves to a non-public address")
        return Target(url, scheme, host, port, tuple(addresses))
