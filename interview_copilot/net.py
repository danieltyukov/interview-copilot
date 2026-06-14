"""Lightweight online/offline detection.

A background thread periodically opens a short TCP connection to a few well-known
hosts. The first that connects means we're online. It calls ``on_change(online)``
only on transitions, so the engine can re-route (cloud ↔ local) and the UI can
show a live marker — even when WiFi drops mid-interview.
"""

from __future__ import annotations

import socket
import threading
from typing import Callable

# (host, port) probes — DNS (53) and HTTPS (443) on hosts that are almost always
# reachable when there is any internet at all.
PROBES = [("1.1.1.1", 443), ("8.8.8.8", 53), ("api.deepgram.com", 443)]


def check_online(timeout: float = 2.0) -> bool:
    for host, port in PROBES:
        try:
            socket.create_connection((host, port), timeout=timeout).close()
            return True
        except OSError:
            continue
    return False


class ConnectivityMonitor:
    def __init__(self, on_change: Callable[[bool], None] | None = None,
                 interval: float = 7.0) -> None:
        self.on_change = on_change or (lambda online: None)
        self.interval = interval
        self._online = True
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def is_online(self) -> bool:
        return self._online

    def start(self) -> None:
        self._online = check_online()        # seed before the UI first renders
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def poll_once(self) -> bool:
        """One connectivity check; fire on_change only on a transition."""
        now = check_online()
        if now != self._online:
            self._online = now
            self.on_change(now)
        return now

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            self.poll_once()

    def stop(self) -> None:
        self._stop.set()
