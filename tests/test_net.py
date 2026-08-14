import meeting_copilot.net as net
from meeting_copilot.net import ConnectivityMonitor


def test_monitor_fires_only_on_transition(monkeypatch):
    calls = []
    m = ConnectivityMonitor(on_change=calls.append)
    m._online = True

    monkeypatch.setattr(net, "check_online", lambda timeout=2.0: False)
    m.poll_once()
    assert m.is_online() is False and calls == [False]   # online -> offline

    m.poll_once()                                         # still offline
    assert calls == [False]                               # no duplicate event

    monkeypatch.setattr(net, "check_online", lambda timeout=2.0: True)
    m.poll_once()
    assert m.is_online() is True and calls == [False, True]  # back online


def test_check_online_returns_bool():
    assert isinstance(net.check_online(timeout=2.0), bool)
