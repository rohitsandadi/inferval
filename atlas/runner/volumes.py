"""The two persistent Volumes. Cache = weights/fixtures; runs = all evidence."""
import modal


def cache_volume() -> modal.Volume:
    return modal.Volume.from_name("atlas-cache", create_if_missing=True)


def runs_volume() -> modal.Volume:
    return modal.Volume.from_name("atlas-runs", create_if_missing=True)
